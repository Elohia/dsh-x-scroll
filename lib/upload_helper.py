# -*- coding: utf-8 -*-
"""X 媒体上传助手（curl_cffi 版）。

为什么有这个东西：Node 的 TLS 指纹过不了 upload.x.com 前面的 Cloudflare（实测 400），
而 twitter-cli 自带的 curl_cffi + impersonate=chrome 能过（实测 202）。
所以上传这一段交给 Python，Node 只负责调度和拼 content_state。

stdin:  {"token": str, "ct0": str, "proxy": str|None, "bytes_b64": str, "mime": str, "filename": str}
stdout: {"ok": bool, "media_id_string": str, "media_category": str, "processing": obj|null, "error": str}
"""
import sys, json, base64, time

BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
URL = "https://upload.x.com/i/media/upload.json"


def main():
    try:
        from curl_cffi import requests as creq
        from curl_cffi import CurlMime
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "curl_cffi 不可用（装 twitter-cli 时应该带上了）: %s" % exc}))
        return

    req = json.load(sys.stdin)
    token = req.get("token") or ""
    ct0 = req.get("ct0") or ""
    if not token or not ct0:
        print(json.dumps({"ok": False, "error": "缺 TWITTER_AUTH_TOKEN / TWITTER_CT0"}))
        return
    proxy = req.get("proxy") or None
    proxies = {"https": proxy, "http": proxy} if proxy else None
    headers = {
        "Authorization": "Bearer " + BEARER,
        "Cookie": "auth_token=%s; ct0=%s" % (token, ct0),
        "X-Csrf-Token": ct0,
        "X-Twitter-Active-User": "yes",
        "X-Twitter-Auth-Type": "OAuth2Session",
        "Origin": "https://x.com",
        "Referer": "https://x.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    }
    data = base64.b64decode(req.get("bytes_b64") or "")
    mime = req.get("mime") or "image/png"
    filename = req.get("filename") or "blob"
    is_video = mime.startswith("video/")
    category = "tweet_video" if is_video else ("tweet_gif" if mime == "image/gif" else "tweet_image")

    try:
        r = creq.post(URL + "?command=INIT&total_bytes=%d&media_type=%s&media_category=%s"
                      % (len(data), mime, category), headers=headers, impersonate="chrome", proxies=proxies, timeout=60)
        if r.status_code not in (200, 202):
            print(json.dumps({"ok": False, "error": "INIT %s %s" % (r.status_code, r.text[:200])}))
            return
        js = r.json()
        media_id = js.get("media_id_string") or str(js.get("media_id"))

        mime_form = CurlMime()
        mime_form.addpart(name="media", content_type=mime, filename=filename, data=data)
        r = creq.post(URL + "?command=APPEND&media_id=%s&segment_index=0" % media_id,
                      headers=headers, multipart=mime_form,
                      impersonate="chrome", proxies=proxies, timeout=120)
        if r.status_code not in (200, 204):
            print(json.dumps({"ok": False, "error": "APPEND %s %s" % (r.status_code, r.text[:200])}))
            return

        r = creq.post(URL + "?command=FINALIZE&media_id=%s%s" % (media_id, "&allow_async=true" if is_video else ""),
                      headers=headers, impersonate="chrome", proxies=proxies, timeout=120)
        if r.status_code not in (200, 201, 202):
            print(json.dumps({"ok": False, "error": "FINALIZE %s %s" % (r.status_code, r.text[:200])}))
            return
        js = r.json()
        processing = js.get("processing_info")

        for _ in range(30):
            if not processing or processing.get("state") == "succeeded":
                break
            if processing.get("state") == "failed":
                print(json.dumps({"ok": False, "error": "media processing failed: %s" % json.dumps(processing.get("error"))}))
                return
            time.sleep(min(10, max(1, int(processing.get("check_after_secs") or 2))))
            st = creq.get(URL + "?command=STATUS&media_id=%s" % media_id, headers=headers,
                          impersonate="chrome", proxies=proxies, timeout=60)
            processing = (st.json() or {}).get("processing_info")

        draft_cat = "DraftTweetVideo" if is_video else ("DraftTweetGif" if mime == "image/gif" else "DraftTweetImage")
        print(json.dumps({"ok": True, "media_id_string": media_id, "media_category": draft_cat, "processing": processing}))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))


if __name__ == "__main__":
    main()
