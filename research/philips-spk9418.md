# Philips Evnia SPK9418 — 調査記録（中断・再開用）

日付: 2026-11-19 ・ 状態: **未解明（調査中断）**

## デバイス

| 項目 | 値 |
| --- | --- |
| 製品 | Philips Evnia 4000 Series ゲーミングマウス **SPK9418**（SPK9418B/00, SPK9418W/11 等） |
| センサー | PixArt PAW3311、800〜12,000 DPI（6段階）、1000Hz、6ボタン、52g |
| 接続 | 2.4GHzドングル / Bluetooth / 有線USB-C（3モード） |
| レシーバー | 「Philips Evnia USB Receiver」 **VID 0x25AA / PID 0x2012** |
| 公式ソフト | Evnia Precision Center（Windows） |

## HID構成（実機）

- iface 0: マウス (1/2)
- iface 1: キーボード (1/6) + ベンダーコレクション:
  - **0xFF05/usage 2**: 64バイト入力のみ
  - **0xFF06/usage 2**: 64バイト入出力、**レポートID 0x0b**
- iface 2: **0xFF01/usage 0x10**: **65バイトレポート（レポートID 0x00 + 64データ）** ← 設定チャネルと推定

## 判明していること

- マウス活動時に iface 2 へイベントフレームが飛ぶ:
  ```
  aa fa ae 69 38 01 01 01 d0 5e 00 ... （64バイト）
  ```
  先頭4バイト **`AA FA AE 69`** がマジックヘッダー。
- 既知ファミリー（Compx / MOJI / HID++ / Razer / Swarm）のいずれとも一致しない。
- **ブラインドプローブは全滅**: マジック付き/なし、50種以上のコマンド、チェックサム変種、
  FF06/0x0b経由のping — すべて無応答（拒否応答すら返らない）。
  プロトコルは完全に未知で、要求形式の手がかりが不足している。

## 再開手順（公式ソフトの通信キャプチャ）

ROCCAT Swarmで成功した手法を使う。

1. 公式 **Evnia Precision Center** をインストール
   - ダウンロード: https://gz-dlsw.tpv-tech.com/MNT/PHILIPS/files/Software/EvniaPrecisionCenter.zip
   - 4.5MBのNSISスタブ。インストール時に本体をネットから取得（要インターネット・約500MB）
   - スタブ内に直URLは無し（実行時に取得）。インストール後に配置されるファイルを
     JSバンドル型（Electron等）なら先に静的解析する（Darmoshark方式）
2. ネイティブアプリだった場合: **USBPcapでキャプチャ**
   - `scripts/capture-roccat.ps1` がそのまま使える（管理者PowerShell、全ルートハブ）
   - Precision CenterでDPI・ポーリングレート・LED等を変更しながらキャプチャ
   - `aa fa ae 69` で始まる出力フレームを抽出し、コマンド/チェックサム/応答規則を特定
3. 特定後: `core/transport.js` に6番目のトランスポート型を追加＋
   `devices/philips-spk9418.json` を作成（プロファイル駆動アーキテクチャのまま）

## メモ

- 公式マニュアル（PDF）: documents.philips.com の SPK9418 ユーザーマニュアル
- 参考: Evnia Precision Center は TPV（Top Victory）製。マウス系Evnia
  （3000/4000/5000/6000/7000シリーズ）は共通ソフト。
- USBPcap は本機にインストール済み（`C:\Program Files\USBPcap\USBPcapCMD.exe`）。
