# Logitech HID++ (G PRO X Wireless) — リバースエンジニアリング記録

日付: 2026-11-18 ・ 対象: **Logitech G PRO X Wireless** + Lightspeedレシーバー (046D:C547)
検証環境: Windows 11 / Node.js 24 / node-hid (hidapi)

> ユーザーからは「G Pro Superlight」として報告されたが、HID++デバイス名機能
> (0x0005) が返す名前は **"PRO X Wireless"**、オンボードプロファイルは
> format 1 × 4枠、COLOR_LED_EFFECTS (0x8070) を持つ — いずれもG PRO X Wireless
> の特徴（Superlight 2は format 7 / 0x2202拡張DPI / 0x8061拡張レート）。

## 出典・謝辞

- **Solaar** (pwr-Solaar/Solaar, GPL) — `lib/logitech_receiver/hidpp20_constants.py`
  の機能ID表と `settings_templates.py` のファンクション番号・応答レイアウトが
  一次情報源（0x8060=REPORT_RATEの読み書きが fn 0x10/0x20 であることを特定）。
- **libratbag** — `src/hidpp20.h/.c` のONBOARD PROFILES (0x8100) 構造。
- **Featherweight** (Ad1FPS, MIT) — PRO X Superlight 2向けRust実装。
  ワイヤー形式の確認源: 要求はレポートID **0x11** で20バイト送信（0x12は
  Windowsに拒否される）、swId 0x0A、応答は devIdx+featureIdx+fnバイト一致、
  エラーフレームは featureスロット 0xFF/0x8F。
- 本文の全コマンド・レイアウトは**実機で送受信検証**。

## トランスポート

```
コレクション: usagePage 0xFF00 / usage 2（20バイト長報告）
書き込み:     [0x11, devIdx, featureIdx, (fn<<4)|swId, params…]  20バイト
読み取り:     7バイト(短報) / 20バイト(長報)、レポートID 0x10/0x11
デバイス番号: レシーバー経由は 1〜6（実機は 1）
機能アドレス: プロファイルのfeature IDを ROOT (0x0000 fn0 GetFeature) で
              デバイスごとの機能インデックスに解決してキャッシュ
エラー:       featureスロット 0xFF (HID++ 2.0) / 0x8F (1.0) + コード
              （実測: 2=引数不正=ONBOARDモード中の書き込みなど）
スリープ:     マウスはスリープ中、要求で1〜2.5秒かけて起きて応答する
              （タイムアウトは最低1500msが必要）
```

## 検証済みコマンド表（G PRO X Wireless）

| 機能 | feature | 読み取り | 書き込み | 備考 |
| --- | --- | --- | --- | --- |
| 機能表 | 0x0001 | fn0=個数, fn1=[idx]→ID BE16+type | — | 28個を列挙 |
| デバイス名 | 0x0005 | fn0=長さ, fn1=[offset]→16文字 | — | "PRO X Wireless" |
| 統合バッテリー | 0x1004 | fn1→[4]=% [6]=状態 | — | 95%を確認 |
| 調整可能DPI | 0x2201 | fn2 [sensor0]→[5..6]=DPI BE16, [7..8]=既定 | fn3 [0, hi, lo] | 100〜25600、50刻みに自動スナップ(12345→12350)、25600受理 |
| レポートレート | 0x8060 | fn1→[4]=ms | fn2 [ms] | リストms=1/2/4/8 (mask 0x8B)。書き込みはHOSTモード必須 |
| オンボードプロファイル | 0x8100 | fn0=記述子, fn2=モード(1=ONBOARD/2=HOST), fn4=現在プロファイル | fn1 [mode] | format 1, 4プロファイル。セクター読み書き fn5/6/7/8 |

## ホストモード / オンボードモード（重要な挙動）

- マウスは通常 **ONBOARDモード**（自分のフラッシュ内プロファイルで動作）。
- この状態での設定書き込みは **HID++エラー2（引数不正）で拒否**される。
- **0x8100 fn1 [2] でHOSTモード**に切り替えると書き込みが通り、即時適用される
  （実測: レート 500Hz適用→復元、DPI 1600適用→復元、いずれも読み戻し一致）。
- HOSTモード中のDPI初期値に注意: 初回切替時は既定（実機800）が入る。
- **オンボードへの保存**（G HUBの「オンボードメモリ」相当）には format 1
  セクター (0x1001〜0x1004, 261バイト) への書き込み + CRCが必要 — v1では
  未実装。セクター 0x0001 の先頭: `[rate idx][default stage][shifted][5×DPI LE16]`、
  実機では 400/800/1600/3200/6400 を確認。

## 本ツールでの扱い

- 書き込み前に毎回 `statusSyncBeforeWrite: setHostMode` でHOSTモードを保証。
- 「オンボードプロファイルに戻す」アクション = 0x8100 fn1 [1]。
- DPIスライダー（100〜25600/50）とレート4段（125/250/500/1000Hz）はライブ適用。
  電源再投入でオンボードプロファイルに戻る点をUIヒントに明記。

## 未実装（将来課題）

- オンボードプロファイルへの永続化（format 1 セクター書き込み+CRC、
  Featherweightのバックアップ・検証フロー参照）
- ボタンマッピング (0x8110)、LED (0x8070)、スリープタイマー
  （format 1セクター 0x2C/0x2E の ps/po タイマー）
- 5段階DPIステージ構造の読み書き（セクター内 [3..12] LE16×5）
