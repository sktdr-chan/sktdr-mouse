# 調査記録 — VXE MAD R Major (有線 0x373b:0x103f / ドングル 0x373b:0x1040)

日付: 2026-11-18 / 状態: **プロファイル稼働中 (`devices/vxe-mad-r-major.json`)**

## 1. 出典

| 出典 | 内容 |
| --- | --- |
| **https://github.com/dkbednarczyk/madr** (Apache-2.0) | **一次情報源** — VXE MAD R 用 Rust 実装 (madr-lib)。バッテリー・DPI(X/Y独立)・RGB・デバウンサ・スリープ・センサーモード・ポーリングレートの全コマンド実装 |
| https://bednarczyk.xyz/blog/reverse-engineering-a-gaming-mouse/ | 作者のリバースエンジニアリング記事 |

## 2. プロトコルの特徴（Scyrox系との比較）

| 項目 | Scyrox V6/V8 | VXE MAD R Major |
| --- | --- | --- |
| VID/PID | 0x3554 / F5F6〜F5F7 | **0x373b / 0x103F(有線)・0x1040(ドングル)** |
| パケット形式 | 16バイト、レポートID 8 | **同一** ✓ |
| チェックサム | `(0x55 - 総和 - 8) & 0xFF` | **同一** ✓ |
| 設定方式 | フラッシュ 0x0000-0x00FF 直読み書き | **ページ方式**（アドレス=ページID、各ページ固有長） |
| DPIエンコード | 単一値 [low, low, byte2, ck] | **X/Y独立** [xLow, yLow, hi, ck] |
| DPIレンジ | 50-26000 | **100-30000** |
| ハンドシェーク | あり (CID/MID/接続タイプ) | **なし** — バッテリー照会のみ |
| オンライン照会 | 0x03 (ドングルが応答) | **なし** — バッテリーで生存確認 |

## 3. ページマップ

| ページ | 長 | 内容 |
| --- | --- | --- |
| 0x00 | 6B | `[pollingRate, comp, 03, 52, activeStage(0-based), comp]` |
| 0xA9 | 10B | `[debounce, comp, 01, 54, sleep×10s, comp, 00, 55, 01, 54]` |
| 0xB5 | 6B | `[00, 55, 06, 4f, sensorMode, comp]` (0=Basic, 1=Competitive, 2=Max) |
| 0x0C+8n | 8B | DPIペアn: 2ステージ×[xLow, yLow, hi, ck] |
| 0x2C+8n | 8B | RGBペアn: 2ステージ×[r, g, b, ck(0x55-総和)] |

### 部分書き込み
ページ0x00への2バイト部分書き込み（レート+補数のみ）が**他バイトを保持することを実機確認済み**。
ただしmadr-libは常にページ全体を書き換える（デバウンサ固定値4msを含む）。

### スリープ確認書き込み
スリープ変更は2段階: (1) 0xA9ページへの書き込み → (2) **0xB5確認ブロック** `[01, 54, sleep, comp, 00, 55]` の書き込み。
本プロファイルは `followUp` 機構でこの確認書き込みを自動実行する。

## 4. 実機検証結果 (2026-11-18)

| 操作 | 結果 |
| --- | --- |
| バッテリー | ✅ 45% / 3837mV |
| ページ全読み出し | ✅ 11ページ |
| ポーリングレート no-op (2000Hz) | ✅ ACK・他バイト保持 |
| DPI no-op (stage1=400) | ✅ |
| デバウンサ no-op (4ms) | ✅ |
| スリープ no-op (1分+確認書き込み) | ✅ |

## 5. core拡張

| 拡張 | ファイル | 内容 |
| --- | --- | --- |
| `dpiXY` コーデック | core/codec.js | X/Y独立DPI [xLow, yLow, hi, ck] のエンコード/デコード |
| ページモード | core/adapter.js | `configImage.mode: "pages"` — ページリストから設定イメージを構築 |
| ハンドシェークなし対応 | core/adapter.js | handshake/deviceOnline/versions コマンド未定義プロファイルの初期化 |
| バッテリー監視 | core/adapter.js | deviceOnline不在時はバッテリーポーリングで生存確認 |
| `followUp` 書き込み | core/adapter.js | 設定書き込み後の追加確認ブロック送信 |
