"""Persistent local canvas, with independent copies of uploaded/generated media."""
import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from config import settings

router = APIRouter(prefix="/api/canvas", tags=["Canvas"])
STORE = Path(settings.CODE_DIR) / "canvas"
RESULTS = Path(settings.RESULT_DIR)
_lock = threading.RLock()
MEDIA = {".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".mp4": "video", ".webm": "video", ".mov": "video"}
MAX_UPLOAD = 100 * 1024 * 1024


class Position(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    x: float = Field(0, ge=-10000000, le=10000000)
    y: float = Field(0, ge=-10000000, le=10000000)
    zoom: float = Field(1, ge=0.1, le=3)


class Card(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["text", "image", "video"]
    x: float = Field(ge=-10000000, le=10000000)
    y: float = Field(ge=-10000000, le=10000000)
    width: float = Field(280, ge=180, le=1000)
    height: float = Field(240, ge=160, le=1000)
    title: str = Field("", max_length=200)
    text: str = Field("", max_length=20000)
    url: str = Field("", max_length=500)
    color: Literal["white", "yellow", "blue", "pink"] = "white"
    duration: Literal[5, 10] = 5
    resolution: Literal["480p", "720p"] = "480p"
    ratio: Literal["1:1", "16:9", "9:16"] = "1:1"
    referenceMode: Literal["reference", "first_frame"] = "reference"
    generation: bool = False
    taskId: str = Field("", max_length=80, pattern=r"^([a-f0-9-]{36})?$")

    @field_validator("url")
    @classmethod
    def local_asset_only(cls, value):
        if value and not re.fullmatch(r"/code/canvas/assets/[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)", value):
            raise ValueError("仅支持本地画布素材")
        return value

    @model_validator(mode="after")
    def require_media(self):
        if self.generation and self.kind != "video":
            raise ValueError("当前仅支持视频生成节点")
        if self.url and MEDIA.get(Path(self.url).suffix) != self.kind:
            raise ValueError("卡片类型与素材格式不一致")
        return self


class Connection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    source: str = Field(max_length=80)
    target: str = Field(max_length=80)


class Canvas(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(0, ge=0)
    title: str = Field("我的创意画布", min_length=1, max_length=100)
    nodes: list[Card] = Field(default_factory=list, max_length=500)
    edges: list[Connection] = Field(default_factory=list, max_length=1000)
    viewport: Position = Field(default_factory=Position)

    @model_validator(mode="after")
    def valid_graph(self):
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("卡片 ID 不能重复")
        edge_ids = set()
        pairs = set()
        for edge in self.edges:
            pair = (edge.source, edge.target)
            if edge.source not in ids or edge.target not in ids or edge.source == edge.target or edge.id in edge_ids or pair in pairs:
                raise ValueError("连线无效或重复")
            edge_ids.add(edge.id)
            pairs.add(pair)
        return self


def read_canvas():
    path = STORE / "board.json"
    if not path.exists():
        return Canvas().model_dump()
    try:
        return Canvas.model_validate_json(path.read_text(encoding="utf-8")).model_dump()
    except (ValueError, OSError) as exc:
        raise HTTPException(500, "画布文件读取失败，请先备份并检查本地文件") from exc


@router.get("")
def get_canvas():
    with _lock:
        return read_canvas()


@router.put("")
def save_canvas(board: Canvas):
    with _lock:
        current = read_canvas()
        if current["revision"] != board.revision:
            raise HTTPException(409, "画布已在其他窗口更新，请导出当前草稿后重新加载")
        STORE.mkdir(parents=True, exist_ok=True)
        data = board.model_dump()
        data["revision"] += 1
        path = STORE / f"{uuid.uuid4().hex}.tmp"
        try:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.replace(path, STORE / "board.json")
        finally:
            path.unlink(missing_ok=True)
        return {"revision": data["revision"]}


def asset_result(path: Path, name: str):
    return {"kind": MEDIA[path.suffix.lower()], "url": f"/code/canvas/assets/{path.name}", "title": name[:200]}


@router.post("/upload")
def upload_canvas_media(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in MEDIA:
        raise HTTPException(400, "支持 PNG、JPG、WebP、GIF、MP4、WebM、MOV")
    assets = STORE / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    path = assets / f"{uuid.uuid4().hex}{ext}"
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "单个素材不能超过 100 MB")
                out.write(chunk)
        if not size:
            raise HTTPException(400, "不能上传空文件")
        if MEDIA[ext] == "image":
            from PIL import Image, UnidentifiedImageError
            try:
                with Image.open(path) as img:
                    img.verify()
            except (UnidentifiedImageError, OSError, ValueError) as exc:
                raise HTTPException(400, "图片文件损坏或格式无效") from exc
        return asset_result(path, Path(file.filename or "素材").name)
    except Exception:
        path.unlink(missing_ok=True)
        raise


@router.get("/library")
def asset_library():
    items = []
    if RESULTS.exists():
        for path in RESULTS.rglob("*"):
            if path.is_file() and path.suffix.lower() in MEDIA and path.resolve().is_relative_to(RESULTS.resolve()):
                relative = path.relative_to(RESULTS).as_posix()
                items.append({"path": relative, "title": path.name, "kind": MEDIA[path.suffix.lower()], "url": "/code/result/" + quote(relative), "modified": path.stat().st_mtime})
    items.sort(key=lambda item: item["modified"], reverse=True)
    return {"items": items[:200]}


class ImportAsset(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


@router.post("/import")
def import_generated_asset(item: ImportAsset):
    source = (RESULTS / item.path).resolve()
    if not source.is_relative_to(RESULTS.resolve()) or not source.is_file() or source.suffix.lower() not in MEDIA:
        raise HTTPException(400, "生成素材不存在或路径无效")
    if source.stat().st_size > MAX_UPLOAD:
        raise HTTPException(413, "单个素材不能超过 100 MB")
    assets = STORE / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    target = assets / f"{uuid.uuid4().hex}{source.suffix.lower()}"
    shutil.copyfile(source, target)
    return asset_result(target, source.name)

_jobs_lock = threading.RLock()

# Generation records are independent of board revisions: undo/delete never cancels
# or re-submits a paid provider task. Clients poll the same durable request ID.
class GenerateVideo(BaseModel):
    request_id: str = Field(pattern=r'^[a-f0-9-]{36}$')
    node_id: str = Field(min_length=1, max_length=80)
    image_url: str = Field("", max_length=500)
    image_urls: list[str] = Field(default_factory=list)
    reference_mode: Literal["reference", "first_frame"] = "reference"
    prompt: str = Field(min_length=1, max_length=4000)
    duration: Literal[5, 10] = 5
    resolution: Literal['480p', '720p'] = '480p'
    ratio: Literal['1:1', '16:9', '9:16'] = '1:1'


def job_path(job_id: str):
    if not re.fullmatch(r'[a-f0-9-]{36}', job_id):
        raise HTTPException(400, '任务编号无效')
    return STORE / 'jobs' / f'{job_id}.json'


def write_job(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, path)


def provider_error(exc):
    from config import Config
    message = str(exc)
    response = getattr(exc, 'response', None)
    if response is not None:
        try:
            err = response.json().get('error', {})
            message = f"{err.get('code', '请求失败')}: {err.get('message', '')}"
        except (ValueError, AttributeError):
            message = f'方舟请求失败（HTTP {response.status_code}）'
    if Config.ARK_API_KEY:
        message = message.replace(Config.ARK_API_KEY, '[隐藏]')
    return message[:1200]


@router.post('/generate')
def generate_canvas_video(item: GenerateVideo):
    from config import Config
    from models.video_seedance import SeedanceVideoClient
    if not item.prompt.strip():
        raise HTTPException(400, '请填写视频描述')
    image_urls = item.image_urls or ([item.image_url] if item.image_url else [])
    if not image_urls:
        raise HTTPException(400, '请上传或连接参考图片')
    images = []
    for image_url in image_urls:
        if not re.fullmatch(r'/code/canvas/assets/[a-f0-9]{32}\.(png|jpg|jpeg|webp)', image_url):
            raise HTTPException(400, '参考图请使用已上传的 PNG、JPG 或 WebP 图片')
        image = STORE / 'assets' / Path(image_url).name
        if not image.is_file():
            raise HTTPException(400, '参考图片不存在，请重新上传')
        images.append(image)
    mode = 'reference' if len(images) > 1 else item.reference_mode
    if not Config.ARK_API_KEY:
        raise HTTPException(400, '请先配置火山方舟 API Key')
    with _jobs_lock:
        path = job_path(item.request_id)
        if path.exists():
            previous = json.loads(path.read_text())
            if any(previous.get(k) != v for k, v in {'node_id': item.node_id, 'prompt': item.prompt, 'image_urls': image_urls, 'reference_mode': mode, 'duration':item.duration, 'resolution':item.resolution, 'ratio':item.ratio}.items()):
                raise HTTPException(409, '原任务输入已经改变，请恢复原输入后查询，勿重复提交')
            return previous
        # Reject another active task on the same node, even across tabs.
        for existing in (STORE / 'jobs').glob('*.json'):
            job = json.loads(existing.read_text())
            if job.get('node_id') == item.node_id and job.get('status') in ('submitting', 'queued', 'running'):
                raise HTTPException(409, '该节点已有任务，请先查询原任务')
        job = {'id': item.request_id, 'node_id': item.node_id, 'status': 'submitting',
               'model': 'doubao-seedance-2-0-mini-260615', 'duration': item.duration, 'resolution': item.resolution, 'ratio':item.ratio,
               'prompt': item.prompt, 'image_urls': image_urls, 'reference_mode': mode}
        write_job(path, job)
        try:
            client = SeedanceVideoClient(timeout=30)
            # Normalize image encoding; the legacy adapter handles PNG/JPEG MIME.
            from PIL import Image
            frames = []
            try:
                for index, image in enumerate(images):
                    frame = STORE / 'jobs' / f'{item.request_id}-{index}.png'
                    frames.append(frame)
                    with Image.open(image) as source:
                        source.convert('RGB').save(frame)
                job['provider_id'] = client._submit_task(item.prompt, str(frames[0]), job['model'], item.duration,
                    image_paths=[str(frame) for frame in frames], reference_mode=mode,
                    resolution=item.resolution, ratio=item.ratio, watermark=False)
            finally:
                for frame in frames:
                    frame.unlink(missing_ok=True)
            job['status'] = 'queued'
        except Exception as exc:
            # Never automatically retry an ambiguous submission (could incur a second charge).
            job['status'] = 'failed'
            job['error'] = provider_error(exc) + '；未自动重发，如提交超时请先核对方舟任务记录。'
        write_job(path, job)
        return job


@router.get('/jobs/{job_id}')
def get_canvas_job(job_id: str):
    import requests
    from config import Config
    from models.video_seedance import SeedanceVideoClient
    with _jobs_lock:
        path = job_path(job_id)
        if not path.exists():
            raise HTTPException(404, '任务尚未提交或不存在')
        job = json.loads(path.read_text())
        if job['status'] in ('succeeded', 'failed', 'cancelled', 'expired'):
            return job
        if not job.get('provider_id'):
            # A server interruption while submitting requires manual reconciliation.
            return {**job, 'error': '提交状态待核对，请检查方舟任务记录，避免重复付费。'}
        client = SeedanceVideoClient(timeout=30)
        try:
            response = requests.get(f"{client.base_url}/contents/generations/tasks/{job['provider_id']}",
                headers=client._headers(), timeout=25, proxies=Config.requests_proxies('ark'))
            response.raise_for_status()
            result = response.json()
            state = result.get('status', 'running')
            if state == 'succeeded':
                url = result.get('content', {}).get('video_url') or result.get('video_url')
                if not url:
                    raise ValueError('任务完成但未返回视频地址')
                target = STORE / 'assets' / f"{job_id.replace('-', '')}.mp4"
                temporary = target.with_suffix('.part')
                try:
                    client._download_video(url, str(temporary))
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
                job['asset'] = asset_result(target, '生成视频')
                job['usage'] = result.get('usage', {})
            elif state in ('failed', 'expired', 'cancelled'):
                job['error'] = result.get('error', {}).get('message', '视频生成未成功')
            job['status'] = state
            write_job(path, job)
            return job
        except Exception as exc:
            # Poll/download failures do not discard the provider task or trigger generation.
            raise HTTPException(502, provider_error(exc)) from exc
