"""Canvas persistence and media isolation regression checks; no model API calls."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from api.routers import canvas


class CanvasTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.results = self.root / 'result'
        self.results.mkdir()
        self.patches = [patch.object(canvas, 'STORE', self.root / 'canvas'), patch.object(canvas, 'RESULTS', self.results)]
        for item in self.patches:
            item.start()
        app = FastAPI()
        app.include_router(canvas.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        for item in self.patches:
            item.stop()
        self.temp.cleanup()

    def image_bytes(self):
        buffer = io.BytesIO()
        Image.new('RGB', (20, 20), 'blue').save(buffer, format='PNG')
        return buffer.getvalue()

    def test_save_reload_conflict_and_graph_validation(self):
        board = self.client.get('/api/canvas').json()
        board['nodes'] = [dict(id='a', kind='text', x=-550, y=850, text='分镜一'), dict(id='b', kind='text', x=90, y=-100)]
        board['edges'] = [dict(id='ab', source='a', target='b')]
        board['viewport'] = dict(x=180, y=-210, zoom=.5)
        self.assertEqual(self.client.put('/api/canvas', json=board).json()['revision'], 1)
        loaded = self.client.get('/api/canvas').json()
        self.assertEqual(loaded['nodes'][0]['text'], '分镜一')
        self.assertEqual(loaded['viewport'], board['viewport'])
        self.assertEqual(self.client.put('/api/canvas', json=board).status_code, 409)
        loaded['edges'][0]['target'] = 'missing'
        self.assertEqual(self.client.put('/api/canvas', json=loaded).status_code, 422)
        self.assertEqual(self.client.get('/api/canvas').json()['revision'], 1)

    def test_media_upload_validation_and_independent_copy(self):
        response = self.client.post('/api/canvas/upload', files={'file': ('../../demo.png', self.image_bytes(), 'image/png')})
        self.assertEqual(response.status_code, 200)
        asset = response.json()
        self.assertTrue(asset['url'].startswith('/code/canvas/assets/'))
        self.assertNotIn('..', asset['url'])
        self.assertEqual(self.client.post('/api/canvas/upload', files={'file': ('bad.png', b'broken', 'image/png')}).status_code, 400)
        self.assertEqual(self.client.post('/api/canvas/upload', files={'file': ('bad.html', b'<script>', 'text/html')}).status_code, 400)
        source = self.results / 'frame.png'
        source.write_bytes(self.image_bytes())
        self.assertEqual(len(self.client.get('/api/canvas/library').json()['items']), 1)
        copied = self.client.post('/api/canvas/import', json={'path': 'frame.png'})
        self.assertEqual(copied.status_code, 200)
        source.unlink()
        self.assertTrue((canvas.STORE / 'assets' / Path(copied.json()['url']).name).is_file())
        self.assertEqual(self.client.post('/api/canvas/import', json={'path': '../outside.png'}).status_code, 400)

    def test_limits_duplicates_and_remote_urls(self):
        board = self.client.get('/api/canvas').json()
        card = dict(id='one', kind='text', x=0, y=0)
        board['nodes'] = [card, card]
        self.assertEqual(self.client.put('/api/canvas', json=board).status_code, 422)
        board['nodes'] = [dict(id='one', kind='image', x=0, y=0, url='https://example.com/a.png')]
        self.assertEqual(self.client.put('/api/canvas', json=board).status_code, 422)
        board['nodes'] = [card]
        board['viewport']['zoom'] = 0
        self.assertEqual(self.client.put('/api/canvas', json=board).status_code, 422)
        with patch.object(canvas, 'MAX_UPLOAD', 2):
            self.assertEqual(self.client.post('/api/canvas/upload', files={'file': ('big.png', self.image_bytes(), 'image/png')}).status_code, 413)
        self.assertEqual(list((canvas.STORE / 'assets').iterdir()), [])

    def test_corrupt_save_is_not_overwritten(self):
        canvas.STORE.mkdir()
        (canvas.STORE / 'board.json').write_text('broken')
        self.assertEqual(self.client.get('/api/canvas').status_code, 500)
        self.assertEqual(self.client.put('/api/canvas', json={'revision': 0}).status_code, 500)
        self.assertEqual((canvas.STORE / 'board.json').read_text(), 'broken')


if __name__ == '__main__':
    unittest.main()

class CanvasGenerationTests(CanvasTests):
    def test_empty_media_and_task_survive_save(self):
        board = self.client.get('/api/canvas').json()
        board['nodes'] = [dict(id='v', kind='video', x=0, y=0, generation=True, taskId='11111111-1111-1111-1111-111111111111')]
        self.assertEqual(self.client.put('/api/canvas', json=board).status_code, 200)
        self.assertEqual(self.client.get('/api/canvas').json()['nodes'][0]['taskId'], board['nodes'][0]['taskId'])

    def test_generate_idempotent_and_result_recoverable(self):
        from models.video_seedance import SeedanceVideoClient
        from unittest.mock import Mock
        asset = self.client.post('/api/canvas/upload', files={'file': ('frame.png', self.image_bytes(), 'image/png')}).json()
        data = dict(request_id='22222222-2222-2222-2222-222222222222', node_id='video', image_url=asset['url'], prompt='缓慢推进')
        with patch('config.Config.ARK_API_KEY', 'test-key'), patch.object(SeedanceVideoClient, '_submit_task', return_value='provider-task') as submit:
            first = self.client.post('/api/canvas/generate', json=data)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()['status'], 'queued')
            self.assertEqual(self.client.post('/api/canvas/generate', json=data).json()['id'], data['request_id'])
            self.assertEqual(submit.call_count, 1)
            self.assertFalse(submit.call_args.kwargs['watermark'])
            self.assertEqual(self.client.post('/api/canvas/generate', json={**data, 'prompt':'changed'}).status_code, 409)
            self.assertEqual(self.client.post('/api/canvas/generate', json={**data, 'request_id':'33333333-3333-3333-3333-333333333333'}).status_code, 409)
        response = Mock()
        response.json.return_value = {'status':'succeeded', 'content':{'video_url':'https://example.com/video.mp4'}, 'usage':{'total_tokens':48400}}
        def download(url, path):
            Path(path).write_bytes(b'test-mp4')
        with patch('requests.get', return_value=response), patch.object(SeedanceVideoClient, '_download_video', side_effect=download) as fetch:
            result = self.client.get('/api/canvas/jobs/'+data['request_id']).json()
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(result['usage']['total_tokens'], 48400)
            self.assertTrue((canvas.STORE/'assets'/Path(result['asset']['url']).name).exists())
            self.assertEqual(self.client.get('/api/canvas/jobs/'+data['request_id']).json()['status'], 'succeeded')
            self.assertEqual(fetch.call_count, 1)

    def test_generation_rejects_external_or_missing_images(self):
        data = dict(request_id='44444444-4444-4444-4444-444444444444', node_id='v', prompt='test')
        self.assertEqual(self.client.post('/api/canvas/generate', json={**data, 'image_url':'https://example.com/file.png'}).status_code, 400)
        self.assertEqual(self.client.post('/api/canvas/generate', json={**data, 'image_url':'/code/canvas/assets/'+('a'*32)+'.png'}).status_code, 400)

    def test_multiple_references_reach_provider_without_dropping_images(self):
        from unittest.mock import Mock
        assets = [self.client.post('/api/canvas/upload', files={'file': (f'ref{i}.png', self.image_bytes(), 'image/png')}).json()['url'] for i in range(3)]
        response = Mock(ok=True)
        response.json.return_value = {'id': 'multi-reference-task'}
        data = dict(request_id='55555555-5555-5555-5555-555555555555', node_id='multi',
                    image_urls=assets, reference_mode='first_frame', prompt='参考所有图片')
        with patch('config.Config.ARK_API_KEY', 'test-key'), patch('models.video_seedance.requests.post', return_value=response) as submit:
            result = self.client.post('/api/canvas/generate', json=data)
            self.assertEqual(result.json()['status'], 'queued')
            self.assertEqual(result.json()['reference_mode'], 'reference')
            images = [entry for entry in submit.call_args.kwargs['json']['content'] if entry['type'] == 'image_url']
            self.assertEqual(len(images), 3)
            self.assertTrue(all(entry['role'] == 'reference_image' for entry in images))
            self.assertTrue(all(entry['image_url']['url'].startswith('data:image/png;base64,') for entry in images))
            self.assertEqual(self.client.post('/api/canvas/generate', json=data).status_code, 200)
            self.assertEqual(submit.call_count, 1)
            self.assertEqual(self.client.post('/api/canvas/generate', json={**data, 'image_urls':assets[:2]}).status_code, 409)
        self.assertFalse(list((canvas.STORE/'jobs').glob('*.png')))
