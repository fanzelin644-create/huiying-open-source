import unittest
from unittest.mock import patch
from models.llm_deepseek import DeepSeek


class ProxySettingsTests(unittest.TestCase):
    def test_disabled_proxy_ignores_system_socks_without_network(self):
        with patch.dict('os.environ', {'ALL_PROXY': 'socks5://127.0.0.1:9', 'HTTPS_PROXY': 'socks5://127.0.0.1:9'}), patch('config.Config.provider_proxy', return_value=''):
            llm = DeepSeek(api_key='test-key')
            self.assertFalse(llm.client._client._trust_env)
            llm.client.close()

    def test_explicit_proxy_passed_with_environment_disabled(self):
        with patch('config.Config.provider_proxy', return_value='http://127.0.0.1:9'), patch('models.llm_deepseek.OpenAI'), patch('httpx.Client') as client:
            DeepSeek(api_key='test-key')
            self.assertEqual(client.call_args.kwargs['proxy'], 'http://127.0.0.1:9')
            self.assertFalse(client.call_args.kwargs['trust_env'])

    def test_image_client_ignores_system_socks_without_network(self):
        from models.image_seedream import SeedreamClient
        with patch.dict('os.environ', {'ALL_PROXY': 'socks5://127.0.0.1:9', 'HTTPS_PROXY': 'socks5://127.0.0.1:9'}), patch('config.Config.provider_proxy', return_value=''):
            client = SeedreamClient(api_key='test-key')
            self.assertFalse(client.client._client._trust_env)
            client.client.close()
