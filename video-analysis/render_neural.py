import asyncio
from pathlib import Path

import aiohttp
import edge_tts
import edge_tts.communicate as communicate
import ssl


async def main():
    communicate._SSL_CTX = ssl._create_unverified_context()
    original = aiohttp.TCPConnector.__init__

    def without_broken_local_ca(self, *args, **kwargs):
        kwargs["ssl"] = False
        original(self, *args, **kwargs)

    aiohttp.TCPConnector.__init__ = without_broken_local_ca
    base = Path(__file__).parent
    narration = (base / "narration.txt").read_text(encoding="utf-8")
    speech = edge_tts.Communicate(narration, voice="en-US-JennyNeural", rate="-10%")
    await speech.save(str(base / "voiceover-neural.mp3"))


if __name__ == "__main__":
    asyncio.run(main())
