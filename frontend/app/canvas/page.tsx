'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownToLine, Check, Copy, Expand, Hand, ImagePlus, LayoutDashboard, Link2, Loader2, Minus, MousePointer2, Plus, Redo2, Save, StickyNote, Trash2, Undo2, X, FolderOpen } from 'lucide-react';
import './canvas.css';

type Point = { x: number; y: number };
type Job = { id: string; status: string; error?: string; asset?: Asset; usage?: { total_tokens?: number } };
type Transfer = { id: string; file: File; progress: number; error?: string; xhr?: XMLHttpRequest };
type Card = { referenceMode?: "reference" | "first_frame"; duration?: 5 | 10; resolution?: '480p' | '720p'; ratio?: '1:1' | '16:9' | '9:16'; generation?: boolean; taskId?: string; id: string; kind: 'text' | 'image' | 'video'; x: number; y: number; width: number; height: number; title: string; text: string; url: string; color: 'white' | 'yellow' | 'blue' | 'pink' };
type Edge = { id: string; source: string; target: string };
type Board = { revision: number; title: string; nodes: Card[]; edges: Edge[]; viewport: { x: number; y: number; zoom: number } };
type Asset = { kind: 'image' | 'video'; url: string; title: string; path?: string };
type Gesture = { kind: 'pan' | 'move' | 'resize' | 'box'; id?: string; startX: number; startY: number; before: Board };
const emptyBoard: Board = { revision: 0, title: '我的创意画布', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
const uid = () => crypto.randomUUID();
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable=true]');

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败（${response.status}），请检查内容或后端服务`);
  }
  return response.json();
}

export default function CanvasPage() {
  const [board, setBoard] = useState<Board>(emptyBoard);
  const current = useRef(board);
  const revision = useRef(0);
  const saved = useRef<Board>(emptyBoard);
  const loaded = useRef(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [space, setSpace] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [library, setLibrary] = useState<Asset[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const mediaBusy = useRef(false);
  const [, refreshHistory] = useState(0);
  const undoStack = useRef<Board[]>([]);
  const redoStack = useRef<Board[]>([]);
  const surface = useRef<HTMLDivElement>(null);
  const uploader = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [multi, setMulti] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<{start: Point; end: Point} | null>(null);
  const [wire, setWire] = useState<{ source: string; point: Point } | null>(null);
  const wireRef = useRef<typeof wire>(null);
  const [wireTarget, setWireTarget] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState<{point: Point; source?: string} | null>(null);
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const transfersRef = useRef<Record<string, Transfer>>({});
  const referenceUploader = useRef<HTMLInputElement>(null);
  const referenceTarget = useRef<string | undefined>(undefined);
  const uploadTarget = useRef<string | undefined>(undefined);
  const uploadPoint = useRef<Point | undefined>(undefined);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [librarySelection, setLibrarySelection] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const starting = useRef(new Set<string>());
  const jobsRef = useRef(jobs); jobsRef.current=jobs;
  const [pollErrors, setPollErrors] = useState<Record<string, string>>({});


  const apply = useCallback((next: Board) => {
    current.current = next;
    setBoard(next);
    setSaveState('pending');
  }, []);
  const remember = useCallback((previous: Board) => {
    undoStack.current = [...undoStack.current.slice(-59), previous];
    redoStack.current = [];
    refreshHistory(n => n + 1);
  }, []);
  const change = useCallback((fn: (value: Board) => Board, history = true) => {
    if (!loaded.current || !active.current) return;
    if (history) remember(current.current);
    apply(fn(current.current));
  }, [apply, remember]);

  const load = useCallback(async () => {
    setError('');
    try {
      const value = await request<Board>('/api/canvas');
      if (!active.current) return;
      current.current = value;
      saved.current = value;
      revision.current = value.revision;
      setBoard(value);
      loaded.current = true;
      setReady(true);
      setSaveState('saved');
      undoStack.current = [];
      redoStack.current = [];
      setSelected(null);
      setSelectedEdge(null);
      setConnecting(null);
    } catch (e) { if (active.current) setError((e as Error).message); }
  }, []);

  const save = useCallback(async function persist(): Promise<void> {
    if (!active.current || !loaded.current || inFlight.current || saved.current === current.current || gesture.current) return;
    const snapshot = current.current;
    inFlight.current = true;
    let succeeded = false;
    setSaveState('saving');
    try {
      const result = await request<{ revision: number }>('/api/canvas', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, revision: revision.current }),
      });
      revision.current = result.revision;
      saved.current = snapshot;
      succeeded = true;
      if (active.current) { setSaveState(current.current === snapshot ? 'saved' : 'pending'); setError(''); }
    } catch (e) {
      if (active.current) { setError((e as Error).message); setSaveState('error'); }
    } finally {
      inFlight.current = false;
      if (succeeded && current.current !== snapshot && active.current) setTimeout(() => void persist(), 700);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void load();
    const warn = (event: BeforeUnloadEvent) => {
      if (loaded.current && (mediaBusy.current || current.current !== saved.current)) { event.preventDefault(); event.returnValue = ''; }
    };
    // Protect SPA navigation too: a failed save must not silently discard edits.
    const navigation = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest('a[href]');
      if (link && (mediaBusy.current || current.current !== saved.current) && !window.confirm('画布正在上传或尚未保存。确定离开并放弃未完成的修改吗？')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', navigation, true);
    return () => { active.current = false; window.removeEventListener('beforeunload', warn); document.removeEventListener('click', navigation, true); };
  }, [load]);

  useEffect(() => {
    if (!ready || saveState !== 'pending' || dragging) return;
    const timer = setTimeout(() => void save(), 700);
    return () => clearTimeout(timer);
  }, [board, ready, saveState, save, dragging]);

  const zoomAt = useCallback((nextZoom: number, px?: number, py?: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    change(value => {
      const old = value.viewport;
      const z = clamp(nextZoom, 0.1, 3);
      const x = px ?? rect.width / 2, y = py ?? rect.height / 2;
      return { ...value, viewport: { x: x - (x - old.x) * z / old.zoom, y: y - (y - old.y) * z / old.zoom, zoom: z } };
    }, false);
  }, [change]);

  useEffect(() => {
    const el = surface.current;
    if (!el || !ready) return;
    const wheel = (event: WheelEvent) => {
      if (editable(event.target)) return;
      event.preventDefault();
      if (!event.ctrlKey && !event.metaKey) {
        change(value => ({ ...value, viewport: { ...value.viewport, x: value.viewport.x - event.deltaX, y: value.viewport.y - event.deltaY } }), false);
        return;
      }
      const rect = el.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoomAt(current.current.viewport.zoom * Math.exp(-delta * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [ready, zoomAt, change]);

  const centerPoint = () => {
    const rect = surface.current?.getBoundingClientRect();
    const { x, y, zoom } = current.current.viewport;
    return { x: ((rect?.width || 900) / 2 - x) / zoom - 140, y: ((rect?.height || 600) / 2 - y) / zoom - 120 };
  };
  const addCards = (assets?: Asset[], at?: { x: number; y: number }) => {
    const point = at || centerPoint();
    const items: Card[] = (assets || [null]).map((asset, i) => ({
      id: uid(), kind: asset?.kind || 'text', x: point.x + (i % 3) * 320, y: point.y + Math.floor(i / 3) * 340,
      width: 280, height: asset ? 260 : 240, title: asset?.title || '灵感便签', text: '', url: asset?.url || '', color: asset ? 'white' : 'yellow',
    }));
    if (current.current.nodes.length + items.length > 500) { setError('单张画布最多放置 500 张卡片'); return; }
    change(value => ({ ...value, nodes: [...value.nodes, ...items] }));
    setSelected(items[items.length - 1].id);
    setSelectedEdge(null);
  };
  const patchCard = (id: string, patch: Partial<Card>, history = false) => change(value => ({ ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }), history);
  const removeSelection = useCallback(() => {
    if (!selected && !selectedEdge && !multi.length) return;
    const ids = new Set(multi.length ? multi : selected ? [selected] : []);
    change(value => ({ ...value, nodes: value.nodes.filter(node => !ids.has(node.id)), edges: value.edges.filter(edge => edge.id !== selectedEdge && !ids.has(edge.source) && !ids.has(edge.target)) }));
    setSelected(null); setSelectedEdge(null); setConnecting(null);
    setMulti([]);
  }, [selected, selectedEdge, multi, change]);
  const undo = useCallback((redo = false) => {
    const source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack;
    const previous = source.current.pop();
    if (!previous) return;
    target.current.push(current.current);
    apply({ ...previous, viewport: current.current.viewport });
    setSelected(null); setSelectedEdge(null); setConnecting(null); setMulti([]);
    refreshHistory(n => n + 1);
  }, [apply]);
  const fit = useCallback(() => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    change(value => {
      if (!value.nodes.length) return { ...value, viewport: { x: 0, y: 0, zoom: 1 } };
      const left = Math.min(...value.nodes.map(n => n.x)), top = Math.min(...value.nodes.map(n => n.y));
      const right = Math.max(...value.nodes.map(n => n.x + n.width)), bottom = Math.max(...value.nodes.map(n => n.y + n.height));
      const zoom = clamp(Math.min((rect.width - 120) / (right - left), (rect.height - 160) / (bottom - top), 1.5), 0.1, 3);
      return { ...value, viewport: { zoom, x: (rect.width - (right - left) * zoom) / 2 - left * zoom, y: (rect.height - (bottom - top) * zoom) / 2 - top * zoom } };
    }, false);
  }, [change]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
      if (editable(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setMulti(current.current.nodes.map(n => n.id)); }
      if (e.code === 'Space') { e.preventDefault(); setSpace(true); }
      if (e.key === 'Escape') { wireRef.current = null; setWire(null); setWireTarget(null); setNewMenu(null); setMulti([]); setConnecting(null); setLibrary(null); setSelected(null); setSelectedEdge(null); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelection(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
      if (e.key.toLowerCase() === 'v') setTool('select');
      if (e.key.toLowerCase() === 'h') setTool('hand');
      if (e.key === '0') fit();
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpace(false); };
    const blur = () => setSpace(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [save, undo, removeSelection, fit]);

  const begin = (e: ReactPointerEvent, kind: Gesture['kind'], id?: string) => {
    if (!ready || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { kind, id, startX: e.clientX, startY: e.clientY, before: current.current };
    setDragging(true);
  };
  const move = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    const original = g.before;
    if (g.kind === 'box') {
      const start = worldPoint(g.startX, g.startY), end = worldPoint(e.clientX, e.clientY);
      setSelectionBox({start, end});
      setMulti(current.current.nodes.filter(n => n.x < Math.max(start.x,end.x) && n.x+n.width > Math.min(start.x,end.x) && n.y < Math.max(start.y,end.y) && n.y+n.height > Math.min(start.y,end.y)).map(n => n.id));
    } else if (g.kind === 'pan') {
      apply({ ...current.current, viewport: { ...original.viewport, x: original.viewport.x + dx, y: original.viewport.y + dy } });
    } else {
      const node = original.nodes.find(n => n.id === g.id);
      if (!node) return;
      const z = original.viewport.zoom;
      if (g.kind === 'move' && multi.includes(node.id) && multi.length > 1) {
        apply({...current.current, nodes: current.current.nodes.map(n => {
          const before = original.nodes.find(v => v.id === n.id);
          return before && multi.includes(n.id) ? {...n, x: clamp(before.x + dx/z,-10000000,10000000), y:clamp(before.y+dy/z,-10000000,10000000)} : n;
        })});
        return;
      }
      patchCard(node.id, g.kind === 'move' ? { x: clamp(node.x + dx / z, -10000000, 10000000), y: clamp(node.y + dy / z, -10000000, 10000000) } : { width: clamp(node.width + dx / z, 180, 1000), height: clamp(node.height + dy / z, 160, 1000) });
    }
  };
  const end = () => {
    const g = gesture.current;
    if (g && g.kind !== 'pan' && g.kind !== 'box' && current.current !== g.before) remember(g.before);
    gesture.current = null; setDragging(false); setSelectionBox(null);
  };
  const worldPoint = (clientX: number, clientY: number): Point => {
    const rect = surface.current!.getBoundingClientRect(), v = current.current.viewport;
    return { x: (clientX - rect.left - v.x) / v.zoom, y: (clientY - rect.top - v.y) / v.zoom };
  };
  const pick = (id: string, additive = false) => {
    setSelected(id); setSelectedEdge(null);
    if (additive) setMulti(ids => ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id]);
    else if (!multi.includes(id)) setMulti([]);
  };
  const connect = (source: string, target: string) => {
    if (source === target) return;
    const from = current.current.nodes.find(n => n.id === source), to = current.current.nodes.find(n => n.id === target);
    if (!from || !to) return;
    if (to.kind==='video' && (from.kind !== 'image' || !from.url)) { setError(from.kind==='image'?'这张图片还没有素材，请先点击卡片内的“上传素材”':'请连接图片作为参考，文字内容请填写到下方描述框'); return; }
    if (current.current.edges.length >= 1000) { setError('连线数量已达上限'); return; }
    change(v => ({...v, edges: [...v.edges.filter(e => !(e.source === source && e.target === target)), {id:uid(), source, target}]}));
    setConnecting(null);
  };
  const createNode = (kind: Card['kind'], point = centerPoint(), source?: string, generation = false) => {
    if (current.current.nodes.length >= 500) { setError('画布最多 500 个节点'); return; }
    const node: Card = {id:uid(), kind, x:point.x, y:point.y, width:280, height:280, title:generation ? '参考图生成视频' : kind === 'text' ? '灵感便签' : kind === 'image' ? '图片素材' : '视频素材', text:'', url:'', color:kind === 'text' ? 'yellow' : 'white', generation};
    const from = current.current.nodes.find(n => n.id === source);
    if (source && generation && (from?.kind !== 'image' || !from.url)) { setError('请从已上传图片创建视频生成节点'); return; }
    if (source && current.current.edges.length >= 1000) { setError('连线数量已达上限'); return; }
    change(v => ({...v,nodes:[...v.nodes,node],edges:source ? [...v.edges,{id:uid(),source,target:node.id}] : v.edges}));
    setSelected(node.id); setMulti([]); setNewMenu(null); setConnecting(null);
  };
  const beginWire = (e: ReactPointerEvent, source: string) => {
    if (hand || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const value = {source, point: worldPoint(e.clientX,e.clientY)};
    wireRef.current=value; setWire(value); setConnecting(source);
  };
  useEffect(() => {
    const moveWire = (e: PointerEvent) => {
      const w = wireRef.current;
      if (!w || !surface.current) return;
      const value = {...w,point:worldPoint(e.clientX,e.clientY)};
      wireRef.current=value; setWire(value);
      setWireTarget(document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-input]')?.getAttribute('data-input') || null);
    };
    const endWire = (e: PointerEvent) => {
      const w = wireRef.current;
      if (!w || !surface.current) return;
      const element = document.elementFromPoint(e.clientX,e.clientY);
      const target = element?.closest('[data-input]')?.getAttribute('data-input');
      if (target) connect(w.source,target);
      else if (surface.current.contains(element) && !element?.closest('[data-card]')) setNewMenu({point:worldPoint(e.clientX,e.clientY),source:w.source});
      wireRef.current=null; setWire(null); setWireTarget(null);
    };
    const cancel = () => { wireRef.current=null;setWire(null);setWireTarget(null);setConnecting(null); };
    window.addEventListener('pointermove',moveWire);window.addEventListener('pointerup',endWire);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
    return () => {window.removeEventListener('pointermove',moveWire);window.removeEventListener('pointerup',endWire);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);};
  });
  const setTransfer = (id: string, patch: Partial<Transfer> | null) => {
    const next = {...transfersRef.current};
    if (patch === null) delete next[id]; else next[id] = {...next[id], ...patch};
    transfersRef.current=next;setTransfers(next);
    mediaBusy.current=Object.values(next).some(t => !t.error && t.progress<100);
    setUploading(mediaBusy.current);
  };
  const runTransfer = async (id: string, file: File) => {
    setTransfer(id,{id,file,progress:0,error:undefined});
    try {
      if (!/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(file.name)) throw new Error('格式不支持，请选 PNG、JPG、WebP、GIF、MP4、WebM 或 MOV');
      if (file.size > 100*1024*1024) throw new Error('文件超过 100 MB');
      const asset = await new Promise<Asset>((resolve,reject) => {
        const xhr=new XMLHttpRequest();setTransfer(id,{xhr});
        xhr.open('POST','/api/canvas/upload'); xhr.timeout=180000;
        xhr.upload.onprogress=e => {if(e.lengthComputable)setTransfer(id,{progress:Math.min(99,Math.round(e.loaded/e.total*100))});};
        xhr.onload=() => {try {const data=JSON.parse(xhr.responseText); if(xhr.status>=200 && xhr.status<300)resolve(data);else reject(new Error(typeof data.detail==='string'?data.detail:'上传失败'));}catch{reject(new Error('上传响应无效'));}};
        xhr.onerror=()=>reject(new Error('网络中断，请重试'));xhr.ontimeout=()=>reject(new Error('上传超时，请重试'));xhr.onabort=()=>reject(new Error('已取消，可重试'));
        const form=new FormData();form.append('file',file);xhr.send(form);
      });
      const existing=current.current.nodes.find(n=>n.id===id);
      if (existing) {
        let height=existing.height;
        if(asset.kind==='image' && !existing.url) {try {height=await new Promise<number>(resolve=>{const img=new Image();img.onload=()=>resolve(clamp(280*img.naturalHeight/img.naturalWidth+65,180,500));img.onerror=()=>resolve(280);img.src=asset.url;});}catch{ /* Keep default dimensions. */ }}
        patchCard(id,{kind:asset.kind,url:asset.url,title:asset.title,height},true);
      }
      setTransfer(id,null);
    } catch(e) {setTransfer(id,{error:(e as Error).message});}
  };
  const upload = async (files: FileList | File[], at?: Point, replaceId?: string, referenceId?: string) => {
    const list=Array.from(files);if(!list.length)return;
    if(replaceId && list.length>1){setError('替换素材时请选择一个文件');return;}
    if(referenceId && list.some(file=>!/\.(png|jpe?g|webp)$/i.test(file.name))){setError("参考图请选择 PNG、JPG 或 WebP");return;}
    if(referenceId && current.current.edges.length+list.length>1000){setError("连线数量已达上限");return;}
    const existing=current.current.nodes.find(n=>n.id===replaceId);
    if(existing && ((existing.kind==='image') !== /\.(png|jpe?g|webp|gif)$/i.test(list[0].name))){setError('替换文件必须与节点类型一致');return;}
    if(!replaceId && current.current.nodes.length+list.length>500){setError('画布最多 500 个节点');return;}
    const point=at||centerPoint();
    const nodes=list.map((file,i):Card=>({id:uid(),kind:/\.(png|jpe?g|webp|gif)$/i.test(file.name)?'image':'video',x:point.x+i%3*320,y:point.y+Math.floor(i/3)*540,width:280,height:280,title:file.name,text:'',url:'',color:'white'}));
    if(!replaceId)change(v=>({...v,nodes:[...v.nodes,...nodes],edges:referenceId?[...v.edges,...nodes.map(n=>({id:uid(),source:n.id,target:referenceId}))]:v.edges}));
    list.forEach((file,i)=>void runTransfer(replaceId||nodes[i].id,file));
    if(uploader.current)uploader.current.value='';
    uploadTarget.current=undefined;
  };
  useEffect(()=>{
    const paste=(e:ClipboardEvent)=>{if(editable(e.target)||!loaded.current)return;const files=Array.from(e.clipboardData?.files||[]);if(files.length){e.preventDefault();void upload(files);}};
    window.addEventListener('paste',paste);return()=>window.removeEventListener('paste',paste);
  });
  const chooseUpload=(id?:string)=>{uploadTarget.current=id;uploader.current?.click();};
  const arrange=()=>change(v=>({...v,nodes:v.nodes.map((n,i)=>({...n,x:(i%3)*340,y:Math.floor(i/3)*540}))}));
  const generate = async (node: Card, recover = false) => {
    if(starting.current.has(node.id))return;
    const refs=current.current.edges.filter(e=>e.target===node.id).map(e=>current.current.nodes.find(n=>n.id===e.source)).filter(Boolean) as Card[];
    if(!refs.length||refs.some(ref=>ref.kind!=='image'||!ref.url)){setError('请连接参考图片，并等待所有图片上传完成');return;}
    if(!node.text.trim()){setError('请填写视频描述');return;}
    starting.current.add(node.id);
    const id=recover && node.taskId ? node.taskId : uid();
    patchCard(node.id,{taskId:id,generation:true},true);setJobs(v=>({...v,[id]:{id,status:'submitting'}}));
    try {
      const result=await request<Job>('/api/canvas/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:id,node_id:node.id,image_urls:refs.map(ref=>ref.url),reference_mode:refs.length>1?'reference':(node.referenceMode||'reference'),prompt:node.text,duration:node.duration||5,resolution:node.resolution||'480p',ratio:node.ratio||'1:1'})});
      setJobs(v=>({...v,[id]:result}));
    }catch(e){setPollErrors(v=>({...v,[id]:(e as Error).message+'；请查询原任务，勿重复生成'}));}
    finally{starting.current.delete(node.id);}
  };
  useEffect(()=>{
    if(!ready)return;
    let stopped=false, polling=false;
    const poll=async()=>{
      if(polling)return;polling=true;
      const ids=[...new Set(current.current.nodes.map(n=>n.taskId).filter(Boolean))] as string[];
      for(const id of ids){
        if(starting.current.size)continue;
        if(['succeeded','failed','expired','cancelled'].includes(jobsRef.current[id]?.status))continue;
        try{
          const result=await request<Job>('/api/canvas/jobs/'+id);if(stopped)return;
          setJobs(v=>({...v,[id]:result}));setPollErrors(v=>({...v,[id]:''}));
          if(result.status==='succeeded'&&result.asset)change(v=>({...v,nodes:v.nodes.map(n=>n.taskId===id?{...n,url:result.asset!.url}:n)}));
        }catch(e){if(!stopped)setPollErrors(v=>({...v,[id]:(e as Error).message}));}
      }
      polling=false;
    };
    void poll();const timer=setInterval(()=>void poll(),6000);
    return()=>{stopped=true;clearInterval(timer);};
  },[ready,change]);
  const openLibrary = async () => {
    setLibrary([]); setLibrarySelection([]); setLibraryQuery(''); setLibraryLoading(true); setError('');
    try { setLibrary((await request<{ items: Asset[] }>('/api/canvas/library')).items); }
    catch (e) { setError((e as Error).message); }
    finally { setLibraryLoading(false); }
  };
  const importAsset = async (item: Asset, at?: Point) => {
    if (mediaBusy.current) return;
    mediaBusy.current = true;
    setUploading(true);
    try {
      const asset = await request<Asset>('/api/canvas/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path }) });
      addCards([asset],at);
    } catch (e) { setError((e as Error).message); }
    finally { mediaBusy.current = false; setUploading(false); }
  };
  const importSelected = async () => {
    const at=centerPoint();
    for(const [i,path] of librarySelection.entries()) {const item=library?.find(a=>a.path===path);if(item)await importAsset(item,{x:at.x+(i%3)*320,y:at.y+Math.floor(i/3)*340});}
    setLibrarySelection([]);
  };
  const exportBoard = () => {
    const blob = new Blob([JSON.stringify({ ...current.current, revision: revision.current }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${board.title || '创意画布'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectedCard = board.nodes.find(node => node.id === selected);
  const { x, y, zoom } = board.viewport;
  const hand = tool === 'hand' || space;

  return (
    <section className={`hy-canvas-page ${selectedCard?.kind==='video'?'hy-has-panel':''}`}>
      <header className="hy-canvas-header">
        <div className="hy-canvas-brand"><LayoutDashboard size={21} /><span>无限画布</span><span className="hy-canvas-divider" /></div>
        <input aria-label="画布名称" className="hy-canvas-title" value={board.title} maxLength={100} disabled={!ready} onFocus={() => remember(current.current)} onChange={e => change(value => ({ ...value, title: e.target.value || '未命名画布' }), false)} />
        <span className={`hy-save-state ${saveState === 'error' ? 'hy-save-error' : ''}`} aria-live="polite">{saveState === 'saving' ? <Loader2 size={13} className="animate-spin" /> : saveState === 'saved' ? <Check size={13} /> : null}{!ready ? '连接中' : ({ saved: '已保存到本机', pending: '有未保存的修改', saving: '保存中…', error: '保存失败' })[saveState]}</span>
        <button className="hy-canvas-button" onClick={exportBoard} disabled={!ready} title="导出布局 JSON（媒体保留在本机）"><ArrowDownToLine size={16} /><span className="hy-wide-label">导出布局</span></button>
        <button className="hy-canvas-button hy-primary" onClick={() => void save()} disabled={!ready || saveState === 'saving' || saveState === 'saved'}><Save size={15} /><span>保存</span></button>
      </header>
      {error && <div className="hy-canvas-error" role="alert"><span>{error}</span><button onClick={() => { if (!ready || window.confirm('重新加载会放弃未保存修改。请先导出需要保留的布局。继续吗？')) void load(); }}>重新加载</button><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
      <div ref={surface} className={`hy-canvas-surface ${hand ? 'hy-hand' : ''} ${dragging ? 'hy-dragging' : ''}`} data-testid="canvas-surface"
        style={{ backgroundSize: `${24 * zoom}px ${24 * zoom}px`, backgroundPosition: `${x}px ${y}px` }}
        onPointerDown={e => { if (hand || e.button === 1) { begin(e,'pan');return; } if (!(e.target as HTMLElement).closest('[data-card], [data-edge],button,input')) { setSelected(null);setSelectedEdge(null);setMulti([]);setNewMenu(null);setConnecting(null);begin(e,'box'); } }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onDoubleClick={e => { if (!ready || (e.target as HTMLElement).closest('[data-card], [data-edge]')) return; setNewMenu({point:worldPoint(e.clientX,e.clientY)}); }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { e.preventDefault(); if (ready) void upload(e.dataTransfer.files,worldPoint(e.clientX,e.clientY)); }}>
        <div className="hy-canvas-world" style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}>
          <svg className="hy-canvas-edges" width="1" height="1" aria-label="卡片连线">
            <defs><marker id="hy-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#a68d69" /></marker></defs>
            {board.edges.map(edge => {
              const from = board.nodes.find(n => n.id === edge.source), to = board.nodes.find(n => n.id === edge.target);
              if (!from || !to) return null;
              const direction = 1;
              const sx = from.x + (direction > 0 ? from.width : 0), sy = from.y + from.height / 2;
              const tx = to.x + (direction > 0 ? 0 : to.width), ty = to.y + to.height / 2;
              const bend = direction * Math.max(70, Math.abs(tx - sx) * 0.45);
              const d = `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`;
              return <g key={edge.id} data-edge="true" onPointerDown={e => { if (hand) return; e.stopPropagation(); setSelected(null); setSelectedEdge(edge.id); }}><path d={d} fill="none" stroke="transparent" strokeWidth={16} className="hy-edge-hit" /><path d={d} fill="none" stroke={selectedEdge === edge.id ? '#e4b368' : '#887e70'} strokeWidth={2} markerEnd="url(#hy-arrow)" pointerEvents="none" /></g>;
            })}
            {wire && (()=>{const n=board.nodes.find(n=>n.id===wire.source);if(!n)return null;return <path d={`M${n.x+n.width},${n.y+n.height/2} C${n.x+n.width+80},${n.y+n.height/2} ${wire.point.x-80},${wire.point.y} ${wire.point.x},${wire.point.y}`} fill="none" stroke="#efbd70" strokeWidth={2/zoom} strokeDasharray="7 5"/>;})()}
          </svg>
          {selectionBox && <div className="hy-marquee" style={{left:Math.min(selectionBox.start.x,selectionBox.end.x),top:Math.min(selectionBox.start.y,selectionBox.end.y),width:Math.abs(selectionBox.end.x-selectionBox.start.x),height:Math.abs(selectionBox.end.y-selectionBox.start.y)}}/>}
          {newMenu && <div className="hy-node-menu" style={{left:Math.max(-x/zoom,Math.min(newMenu.point.x,((surface.current?.clientWidth||900)-220-x)/zoom)),top:Math.max(-y/zoom,Math.min(newMenu.point.y,((surface.current?.clientHeight||600)-320-y)/zoom)),transform:`scale(${1/zoom})`,transformOrigin:'top left'}} onPointerDown={e=>e.stopPropagation()}><strong>{newMenu.source?'引用该节点新建':'新建节点'}</strong><button onClick={()=>createNode('text',newMenu.point,newMenu.source)}>文字便签</button><button onClick={()=>createNode('image',newMenu.point,newMenu.source)}>图片素材</button><button onClick={()=>createNode('video',newMenu.point,newMenu.source,true)}>视频节点</button><button onClick={()=>{uploadPoint.current=newMenu.point;chooseUpload();setNewMenu(null);}}>上传素材</button><button onClick={()=>{void openLibrary();setNewMenu(null);}}>从素材库选择</button><button onClick={()=>setNewMenu(null)}>取消</button></div>}
          {board.nodes.map(node => <article key={node.id} tabIndex={0} aria-label={`${node.title || '未命名卡片'}，按回车选中`} onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') pick(node.id); }} data-card={node.id} className={`hy-canvas-card hy-card-${node.color} ${selected === node.id || multi.includes(node.id) ? 'hy-selected' : ''} ${connecting === node.id ? 'hy-connecting' : ''}`} style={{ left: node.x, top: node.y, width: node.width, height: node.height }} onPointerDown={e => { if (hand || e.button === 1) return; e.stopPropagation(); pick(node.id,e.shiftKey); }}>
            <div className="hy-card-handle" data-testid="card-handle" onPointerDown={e => { if (hand || e.button === 1) return; pick(node.id); begin(e, 'move', node.id); }}><span>{node.kind === 'text' ? '文字便签' : node.kind === 'image' ? '图片素材' : '视频素材'}</span><span className="hy-handle-dots">⠿</span></div>
            <input aria-label="卡片标题" className="hy-card-title" value={node.title} maxLength={200} onFocus={() => remember(current.current)} onChange={e => patchCard(node.id, { title: e.target.value })} />
            {node.kind === 'text' ? <textarea aria-label="便签内容" placeholder="写下灵感…" value={node.text} maxLength={20000} onFocus={() => remember(current.current)} onChange={e => patchCard(node.id, { text: e.target.value })} /> : <div className="hy-card-media">
              {node.url ? node.kind === 'image' ? <img draggable={false} src={node.url} alt={node.title} /> : <video src={node.url} controls preload="metadata" onError={()=>setError('视频编码无法播放，请替换为 H.264 MP4 或 WebM')}/> : <div className="hy-media-empty"><span>{node.generation?'连接一张或多张参考图，选中节点填写描述':node.kind==='image'?'图片素材':'视频素材'}</span><button onClick={()=>chooseUpload(node.id)}>上传素材</button></div>}
              {transfers[node.id] && <div className="hy-transfer" role="status"><span>{transfers[node.id].error||`上传中 ${transfers[node.id].progress}%`}</span>{transfers[node.id].error?<button onClick={()=>void runTransfer(node.id,transfers[node.id].file)}>重试</button>:<button onClick={()=>transfers[node.id].xhr?.abort()}>取消</button>}</div>}
            </div>}
            {!node.generation && node.kind!=='text' && node.url && <button className="hy-replace" onClick={()=>chooseUpload(node.id)}>替换素材</button>}
            {node.taskId&&<span className="hy-job-badge">{jobs[node.taskId]?.status==='succeeded'?'已生成':jobs[node.taskId]?.status==='failed'?'生成失败':'生成任务 · 查看详情'}</span>}
            <button data-input={node.id} className={`hy-card-port hy-input-port ${wireTarget===node.id?'hy-port-target':''}`} style={{width:Math.max(28,28/zoom),height:Math.max(28,28/zoom)}} aria-label={`连接到 ${node.title}`} title="输入：拖线到这里" onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();if(connecting)connect(connecting,node.id);}}>○</button>
            <button className="hy-card-port hy-output-port" style={{width:Math.max(28,28/zoom),height:Math.max(28,28/zoom)}} aria-label={`从 ${node.title} 开始连线`} title="拖到输入端口连接，拖到空白新建" onPointerDown={e=>beginWire(e,node.id)} onClick={e=>{e.stopPropagation();setConnecting(node.id);}}>+</button>
            <button className="hy-card-resize" aria-label="调整卡片大小" title="拖拽调整大小" onPointerDown={e => begin(e, 'resize', node.id)}>◢</button>
          </article>)}
        </div>
        {!ready && <div className="hy-canvas-empty"><Loader2 className="animate-spin" /><h2>正在打开画布</h2><p>请确认后端服务已启动。</p></div>}
        {ready && board.nodes.length === 0 && <div className="hy-canvas-empty"><div className="hy-empty-mark"><LayoutDashboard size={34} /></div><h2>让灵感在这里展开</h2><p>放下一个想法，连接一组镜头。<br />拖入图片或视频，也可以从一张便签开始。</p><button className="hy-canvas-button hy-primary" onClick={e => { e.stopPropagation(); addCards(); }} onPointerDown={e => e.stopPropagation()}><Plus size={16} />添加第一张便签</button></div>}
      </div>
      <div className="hy-canvas-toolbar" role="toolbar" aria-label="画布工具">
        <button aria-label="选择工具" aria-pressed={tool === 'select'} title="选择（V）" className={tool === 'select' ? 'hy-active' : ''} onClick={() => setTool('select')}><MousePointer2 size={19} /></button>
        <button aria-label="平移工具" aria-pressed={tool === 'hand'} title="平移（H / 按住空格）" className={tool === 'hand' ? 'hy-active' : ''} onClick={() => setTool('hand')}><Hand size={19} /></button>
        <span className="hy-tool-separator" />
        <button aria-label="添加便签" title="添加便签" disabled={!ready} onClick={() => addCards()}><StickyNote size={19} /></button>
        <button aria-label="添加视频生成节点" title="添加视频生成节点" disabled={!ready} onClick={()=>createNode('video',centerPoint(),undefined,true)}><Plus size={19}/></button><button aria-label="整理画布" title="整理画布" disabled={!ready} onClick={()=>{arrange();fit();}}><LayoutDashboard size={19}/></button>
        <button aria-label="上传图片或视频" title="上传图片 / 视频（单个最大 100 MB）" disabled={!ready} onClick={() => chooseUpload()}>{uploading ? <Loader2 size={19} className="animate-spin" /> : <ImagePlus size={19} />}</button>
        <button aria-label="导入已有素材" title="导入已有生成素材" disabled={!ready} onClick={() => void openLibrary()}><FolderOpen size={19} /></button>
        <span className="hy-tool-separator" />
        <button aria-label="撤销" title="撤销（⌘/Ctrl Z）" disabled={!undoStack.current.length} onClick={() => undo()}><Undo2 size={18} /></button>
        <button aria-label="重做" title="重做（⌘/Ctrl Shift Z）" disabled={!redoStack.current.length} onClick={() => undo(true)}><Redo2 size={18} /></button>
      </div>
      {(selectedCard || selectedEdge || multi.length>0) && <div className="hy-selection-tools" role="toolbar" aria-label="选中内容操作">
        {selectedCard && <><span className="hy-selection-label">{selectedCard.kind === 'text' ? '便签' : '素材'}</span>{(['white', 'yellow', 'blue', 'pink'] as const).map((color, i) => <button key={color} aria-label={`设为${['白色', '黄色', '蓝色', '粉色'][i]}`} className={`hy-color hy-card-${color}`} aria-pressed={selectedCard.color === color} onClick={() => patchCard(selectedCard.id, { color }, true)} />)}<span className="hy-tool-separator" /><button aria-label="复制卡片" title="复制卡片" onClick={() => { if (board.nodes.length >= 500) return; const copy = { ...selectedCard, id: uid(), x: selectedCard.x + 32, y: selectedCard.y + 32 }; change(value => ({ ...value, nodes: [...value.nodes, copy] })); setSelected(copy.id); }}><Copy size={17} /></button><button aria-label="连接卡片" title="连接另一张卡片" className={connecting ? 'hy-active' : ''} onClick={() => setConnecting(connecting ? null : selectedCard.id)}><Link2 size={17} /></button></>}
        <button aria-label={selectedEdge ? '删除连线' : '删除卡片'} title="删除（Delete）" onClick={removeSelection}><Trash2 size={17} /></button>
      </div>}
      {selectedCard?.kind==='video' && <aside className="hy-generation-panel" aria-label="视频生成设置">
        <header><strong>参考图生成视频</strong><button aria-label="关闭生成设置" onClick={()=>setSelected(null)}><X size={16}/></button></header>
        <div className="hy-video-options"><span>Seedance 2.0 mini</span><label>分辨率<select aria-label="视频分辨率" value={selectedCard.resolution||'480p'} onChange={e=>patchCard(selectedCard.id,{resolution:e.target.value as '480p'|'720p'},true)}><option value="480p">480p</option><option value="720p">720p</option></select></label><label>时长<select aria-label="视频时长" value={selectedCard.duration||5} onChange={e=>patchCard(selectedCard.id,{duration:Number(e.target.value) as 5|10},true)}><option value={5}>5 秒</option><option value={10}>10 秒</option></select></label><label>比例<select aria-label="视频比例" value={selectedCard.ratio||'1:1'} onChange={e=>patchCard(selectedCard.id,{ratio:e.target.value as '1:1'|'16:9'|'9:16'},true)}><option value="1:1">1:1</option><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option></select></label><label>参考方式<select aria-label="参考方式" value={selectedCard.referenceMode||'reference'} onChange={e=>patchCard(selectedCard.id,{referenceMode:e.target.value as 'reference'|'first_frame'},true)}><option value="reference">多图参考</option><option value="first_frame">首帧引导</option></select></label><span>水印关闭</span></div>
        <button className="hy-canvas-button" onClick={()=>{referenceTarget.current=selectedCard.id;referenceUploader.current?.click();}}>上传参考图（可多选）</button>
        <div className="hy-reference-list">{board.edges.filter(e=>e.target===selectedCard.id).map(edge=>{const ref=board.nodes.find(n=>n.id===edge.source);return ref?<div key={edge.id}><img src={ref.url} alt={ref.title}/><span>参考图 · {ref.title}</span><button aria-label="移除图片引用" onClick={()=>change(v=>({...v,edges:v.edges.filter(e=>e.id!==edge.id)}))}><X size={14}/></button></div>:null;})}
        {!board.edges.some(e=>e.target===selectedCard.id)&&<span>从图片右侧端口连到此节点左侧端口</span>}</div>
        <p>可连接多张图片作为人物、场景或风格参考，描述中说明各图用途。首帧引导仅在单图时使用；多图时会自动按多图参考提交全部图片。</p>
        <textarea aria-label="视频生成描述" placeholder="描述动作与运镜，例如：镜头缓慢推进，衣摆随风轻动" value={selectedCard.text} maxLength={4000} onFocus={()=>remember(current.current)} onChange={e=>patchCard(selectedCard.id,{text:e.target.value})}/>
        <p>参考预算约 ¥{(0.45*(selectedCard.duration||5)/5*(selectedCard.resolution==='720p'?2.25:1)).toFixed(2)}／次（按此前用量和优惠价估算，比例会影响用量，实际以方舟账单为准）</p>
        {selectedCard.taskId&&<div role="status">{pollErrors[selectedCard.taskId]||jobs[selectedCard.taskId]?.error||({queued:'排队中',running:'生成中',submitting:'提交中',succeeded:'生成完成',failed:'生成失败',expired:'任务过期',cancelled:'任务取消'} as Record<string,string>)[jobs[selectedCard.taskId]?.status]||'正在恢复任务状态'}{jobs[selectedCard.taskId]?.usage?.total_tokens&&<p>用量：{jobs[selectedCard.taskId].usage?.total_tokens} tokens</p>}</div>}
        <button className="hy-canvas-button hy-primary" disabled={!selectedCard.text.trim()||!board.edges.some(e=>e.target===selectedCard.id)||(!!selectedCard.taskId&&!['succeeded','failed','expired','cancelled'].includes(jobs[selectedCard.taskId]?.status))} onClick={()=>void generate(selectedCard)}>{selectedCard.taskId?'重新生成（再次计费）':'生成视频'}</button>
        {selectedCard.taskId&&pollErrors[selectedCard.taskId]&&<button className="hy-canvas-button" onClick={()=>void generate(selectedCard,true)}>恢复原任务（不新建任务）</button>}
        {selectedCard.url&&<a href={selectedCard.url} download>下载视频</a>}
      </aside>}
      <div className="hy-canvas-bottom"><span className="hy-canvas-hint">{connecting ? '拖到左侧输入端口 · 空白处新建 · Esc 取消' : `${board.nodes.length} 张卡片 · 空白框选 · 空格拖动平移 · 双指平移 · ⌘/Ctrl 滚轮缩放`}</span><div className="hy-canvas-zoom"><button aria-label="缩小" onClick={() => zoomAt(zoom / 1.2)}><Minus size={16} /></button><button className="hy-zoom-value" title="恢复 100%" onClick={() => zoomAt(1)}>{Math.round(zoom * 100)}%</button><button aria-label="放大" onClick={() => zoomAt(zoom * 1.2)}><Plus size={16} /></button><span className="hy-tool-separator" /><button aria-label="适应全部内容" title="适应全部内容（0）" onClick={fit}><Expand size={17} /></button></div></div>
      <input ref={referenceUploader} type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden onChange={e=>{const target=current.current.nodes.find(n=>n.id===referenceTarget.current);if(e.target.files&&target)void upload(e.target.files,{x:target.x-360,y:target.y+340},undefined,target.id);e.target.value='';}} />
      <input ref={uploader} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov" multiple hidden onChange={e => { if (e.target.files) void upload(e.target.files,uploadPoint.current,uploadTarget.current); uploadPoint.current=undefined; }} />
      {library !== null && <div className="hy-library-backdrop" onClick={() => setLibrary(null)}><section className="hy-library" role="dialog" aria-modal="true" aria-label="已有生成素材" onClick={e => e.stopPropagation()}><header><div><h2>已有生成素材</h2><p>导入副本到画布 · 最近 200 个图片和视频</p><input aria-label="搜索素材" placeholder="搜索名称" value={libraryQuery} onChange={e=>setLibraryQuery(e.target.value)}/><button disabled={uploading||!librarySelection.length} onClick={()=>void importSelected()}>导入选中（{librarySelection.length}）</button></div><button aria-label="关闭素材库" onClick={() => setLibrary(null)}><X size={20} /></button></header>{libraryLoading ? <p className="hy-library-empty">正在读取素材…</p> : library.length ? <div className="hy-library-grid">{library.filter(item=>item.title.toLowerCase().includes(libraryQuery.toLowerCase())).map(item => <button key={item.path} aria-pressed={librarySelection.includes(item.path!)} onClick={() => setLibrarySelection(v=>v.includes(item.path!)?v.filter(p=>p!==item.path):[...v,item.path!])}>{item.kind === 'image' ? <img src={item.url} alt={item.title} /> : <video src={item.url} preload="metadata" />}<span>{item.title}</span><small>{item.kind === 'image' ? '图片' : '视频'} · 点击选择</small></button>)}</div> : <p className="hy-library-empty">还没有生成素材。你可以先在工作台生成，<br />或关闭此窗口，上传本地图片和视频。</p>}</section></div>}
    </section>
  );
}
