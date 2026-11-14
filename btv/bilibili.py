from __future__ import annotations

import hashlib
import re
import time
from urllib.parse import urlencode

import requests

from .models import Segment, Transcript

VIEW_URL = "https://api.bilibili.com/x/web-interface/view"
PLAYER_URL = "https://api.bilibili.com/x/player/wbi/v2"
NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")

_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

_SUBTITLE_PRIORITY = ["zh-Hans", "zh-CN", "ai-zh", "zh", "zh-Hant"]


def resolve_bvid(text: str) -> str:
    match = _BV_RE.search(text)
    if match:
        return match.group(1)
    if text.startswith("http") or "b23.tv" in text:
        try:
            response = requests.get(
                text, headers={"User-Agent": USER_AGENT}, timeout=15, allow_redirects=True
            )
        except requests.RequestException as exc:
            msg = f"短链接解析失败：{exc}"
            raise RuntimeError(msg) from exc
        match = _BV_RE.search(response.url) or _BV_RE.search(response.text[:5000])
        if match:
            return match.group(1)
    raise RuntimeError("无法解析 BV 号，请提供 https://www.bilibili.com/video/BV... 或 BV 号")


def _get_mixin_key(original: str) -> str:
    return "".join(original[index] for index in _MIXIN_KEY_ENC_TAB)[:32]


def _key_from_url(url: str) -> str:
    return url.rsplit("/", 1)[-1].split(".", 1)[0]


class BilibiliClient:
    def __init__(self, sessdata: str = "", timeout: int = 20):
        self.sessdata = sessdata
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {"User-Agent": USER_AGENT, "Referer": "https://www.bilibili.com/"}
        )
        if sessdata:
            self.session.headers["Cookie"] = f"SESSDATA={sessdata}"
        self._wbi_keys: tuple[str, str] | None = None

    def get_meta(self, bvid: str) -> dict:
        view = self._request(VIEW_URL, {"bvid": bvid})
        cid = view.get("cid")
        if not cid and view.get("pages"):
            cid = (view["pages"][0] or {}).get("cid")
        if not cid:
            raise RuntimeError("未能获取视频 cid")
        return {
            "aid": view.get("aid"),
            "cid": cid,
            "title": view.get("title") or bvid,
            "owner": (view.get("owner") or {}).get("name") or "",
            "duration": int(view.get("duration") or 0),
        }

    def get_transcript(self, bvid: str) -> Transcript:
        meta = self.get_meta(bvid)
        self.session.headers["Referer"] = f"https://www.bilibili.com/video/{bvid}/"
        player = self._request(
            PLAYER_URL,
            {"aid": meta["aid"], "cid": meta["cid"], "bvid": bvid},
            wbi=True,
        )
        subtitles = (player.get("subtitle") or {}).get("subtitles") or []
        if not subtitles:
            hint = "SESSDATA 可能已失效" if self.sessdata else "未提供 SESSDATA"
            raise RuntimeError(f"该视频没有可用字幕（{hint}）")

        chosen = self._pick_subtitle(subtitles)
        segments = self._fetch_subtitle(chosen["subtitle_url"])
        if not segments:
            raise RuntimeError("字幕文件内容为空")

        return Transcript(
            bvid=bvid,
            title=meta["title"],
            owner=meta["owner"],
            duration=meta["duration"],
            source="subtitle",
            segments=segments,
        )

    def _pick_subtitle(self, subtitles: list[dict]) -> dict:
        for language in _SUBTITLE_PRIORITY:
            for item in subtitles:
                if item.get("lan") == language and item.get("subtitle_url"):
                    return item
        for item in subtitles:
            if str(item.get("lan", "")).startswith("zh") and item.get("subtitle_url"):
                return item
        for item in subtitles:
            if item.get("subtitle_url"):
                return item
        raise RuntimeError("字幕列表中没有可下载的字幕地址")

    def _fetch_subtitle(self, subtitle_url: str) -> list[Segment]:
        url = subtitle_url if subtitle_url.startswith("http") else "https:" + subtitle_url
        response = self.session.get(url, timeout=self.timeout)
        response.raise_for_status()
        body = response.json().get("body") or []
        segments = []
        for item in body:
            text = str(item.get("content") or "").strip()
            if text:
                segments.append(
                    Segment(float(item["from"]), float(item["to"]), text)
                )
        return segments

    def _request(self, url: str, params: dict, wbi: bool = False) -> dict:
        query = self._sign(params) if wbi else params
        response = self.session.get(url, params=query, timeout=self.timeout)
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            raise RuntimeError(
                f"B 站接口错误 {payload.get('code')}: {payload.get('message')}"
            )
        return payload.get("data") or {}

    def _sign(self, params: dict) -> dict:
        img_key, sub_key = self._get_wbi_keys()
        mixin_key = _get_mixin_key(img_key + sub_key)
        signed = {
            key: str(value) for key, value in params.items() if value is not None
        }
        signed["wts"] = str(int(time.time()))
        signed = dict(sorted(signed.items()))
        query = urlencode(signed)
        signed["w_rid"] = hashlib.md5((query + mixin_key).encode()).hexdigest()
        return signed

    def _get_wbi_keys(self) -> tuple[str, str]:
        if self._wbi_keys:
            return self._wbi_keys
        data = self._request(NAV_URL, {})
        wbi_img = data.get("wbi_img") or {}
        img_key = _key_from_url(wbi_img.get("img_url") or "")
        sub_key = _key_from_url(wbi_img.get("sub_url") or "")
        if not img_key or not sub_key:
            raise RuntimeError("获取 WBI 签名密钥失败")
        self._wbi_keys = (img_key, sub_key)
        return self._wbi_keys
