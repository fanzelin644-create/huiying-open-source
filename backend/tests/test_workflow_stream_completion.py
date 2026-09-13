import asyncio
import json
import queue
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from api.services.project_helpers import stream_workflow_task


class CompletionTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, failure=False):
        async def execute(*args, **kwargs):
            await asyncio.sleep(0.01)
            if failure:
                raise ValueError("save failed")
            return {"stage_completed":True}
        engine = SimpleNamespace(execute_stage=execute, persist_session_snapshot=Mock(return_value={}))
        stream = stream_workflow_task(
            request=SimpleNamespace(is_disconnected=AsyncMock(return_value=False)),
            workflow_engine=engine, state=SimpleNamespace(session_id="test"),
            stage="storyboard", input_data={}, cancellation_check=lambda:False,
            progress_callback=lambda *args:None, progress_events=queue.Queue(),
            event_trigger=asyncio.Event())
        async def drain():
            return [json.loads(event) async for event in stream]
        return await asyncio.wait_for(drain(), timeout=1)

    async def test_save_without_progress_returns_immediately(self):
        events = await self.collect()
        self.assertEqual([event["type"] for event in events], ["stage_complete"])

    async def test_error_without_progress_returns_immediately(self):
        events = await self.collect(True)
        self.assertEqual(events[0]["type"], "error")
        self.assertEqual(events[0]["content"], "save failed")
