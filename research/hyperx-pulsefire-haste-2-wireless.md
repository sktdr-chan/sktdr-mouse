# HyperX Pulsefire Haste 2 Wireless — 解析記録

- 日付: 2026-11-19
- 状態: **プロファイル稼働中** (`devices/hyperx-pulsefire-haste-2-wireless.json`)
- 実機: HyperX Pulsefire Haste 2 Wireless（HP Inc.）、2.4GHz ドングル接続
- USB: `03f0:0f98`（別リビジョン `03f0:0d97` も同一プロトコル）
- 制御コレクション: interface 2 / usagePage `0xFF00`
- レポート: **64バイト（レポートID = コマンドバイト、byte1 = サブコマンド）**、Featureレポートも64バイト
- ファームウェア表示: USB bcdDevice `0x4104` → `v4.1.0.4`

## プロトコル出典

- [PMarinov1994/ngenuity-linux-cli](https://github.com/PMarinov1994/ngenuity-linux-cli)（MIT）
  — NGENUITY 3.1.0 の通信ハブ (`hxn-srv-communication-hub.exe`) を解析した
  「NGENUITY universal」プロトコル資料。Haste 2 Wireless 実機のキャプチャ
  （DPI / ポーリング / LOD / 明るさ / ボタン）付き。
- [HeyOkay/HaloBattery — docs/protocols.md](https://github.com/HeyOkay/HaloBattery/blob/main/docs/protocols.md#hyperx-pulsefire-haste-2-wireless-ngenuity-protocol)
  — バッテリー/リンクの `50 02` / `52 01` の確認記録。

## トランスポート

```
request : [cmd][sub][payload…] を64バイトにゼロ埋め
reply   : [cmd+1][sub][data…]   （例: 50 02 → 51 02）
ACK     : ff 01 <device id 12B> <cmd> <sub> <status> 00 …   （ドングルが全パケットに返す）
```

- 64バイト出力はレポートIDを付けずにそのまま書き込む（`report_id == cmd`）
- コマンド間は **10ms以上** 空ける（NGENUITYと同じ）
- 読み取りコマンドはACKではなく `cmd+1` の実応答を待つ
- 書き込みコマンドはドングルACKで完了
- ターゲットビット（byte1 の上位2ビット）は本ドングルでは**使わない**（plain sub）

## 読み取りコマンド（実機確認済み）

### 10 01 — デバイス情報

`11 01` が返る。デバイスID・カテゴリ・VID・PID一覧などを含む。
本ソフトは接続判定（プローブ）にのみ使用。

### 52 01 — 無線リンク状態

`53 01 <connected>`（byte2 が 1 = 接続、0 = スリープ/電源OFF）。
本ソフトはこれを `deviceOnline` として使い、スリープ復帰を監視します。

### 50 02 — バッテリー

```
51 02 <level> <charge> <temp i16 LE> <voltage u16 LE> <gauge> <charger> …
      ^^      ^^^^^^
      |       charge: 0 非充電, 1 充電中, 2 満充電, 3 エラー, FF 不明
      level: 0..100
```

例: `51 02 53 01 18 00 31 10 01 00` → 83%、充電中、24℃、4145mV。

### 32 02 — DPIテーブル

`32 02 <profile>` → `33 02 <rate> <mask> <active> <stage…>`:

```
[2]    polling rate code: 40=125, 20=250, 10=500, 08=1000, 04=2000, 02=4000, 01=8000
[3]    enabled stage bitmask (bit i = stage i)
[4]    active stage (0-based)
[5+5i] stage i: u16 LE code = DPI/50 - 1, R, G, B
```

書き込みは `32 01 <profile u16 LE> …` で同じレイアウト（[2..3] が profile）。
slot 0 = ライブ、slot 1 = オンボード（電源再投入後は slot 1 が slot 0 に読み込まれる）。
本ソフトは変更時に **slot 0 と slot 1 の両方**へ書き込みます。

### 36 02 — センサー設定

`36 02 <profile>` → `37 02 <angleSnap> <angleTune> <angleTuneEnable> <liftOff> <motionSync>`。
liftOff: `00` = 1mm、`02` = 2mm。書き込みは `36 01 <profile u16 LE> …`。

### 40 02 — 明るさ

`40 02 <profile>` → `41 02 <raw 0..255>`。
書き込みは `40 01 <profile u16 LE> <raw>`。UIの%は `round(raw*100/255)` で換算。

### 42 03 — ライト設定

`42 03 <profile>` → `43 03 <mode> <duration u16 LE> <direction> <colourType> <colours…>`。
mode: 0 Off, 1 Solid, 2 Breath, 4 ColorCycle, 6 FrameLight。

## 書き込みコマンド（実機確認済み）

### 32 01 — DPIテーブル（slot 0 / slot 1）

上記レイアウト。ステージ数変更時は `mask = (1<<count)-1`、active を範囲内に補正。
現在ステージ変更・DPI値・ステージ色も同じテーブルを書き換えて送信します。

### 36 01 — センサー（LOD）

`36 01 <profile u16 LE> <angleSnap> <angleTune> <angleTuneEnable> <liftOff> <motionSync>`。
本ソフトは読み取った値を保持し、LODだけ変更します。

### 40 01 — 明るさ

`40 01 <profile u16 LE> <raw>`。

### 42 02 — ライトプリセット

```
42 02 <profile u16 LE> <mode> <duration u16 LE> [direction] [colourType] [RGB...]
```

実機で使用できるモード: **0 Off / 1 Solid / 2 Breath / 4 ColorCycle**。
- Solid: プリセットに色を渡せる（`01 00 00 00 01 R G B` の形）
- Breath: `02 <dur> 00 00 01 R G B`
- ColorCycle: `04 <dur> 00 00 FE`（スペクトル固定）
- 本ソフトの Solid は、確実に電源再投入後も残る **FrameLight 1フレーム**方式も併用

### 44 02 / 44 03 / 44 04 — ライブカラーとFrameLight

```
44 02 00 00 R G B                      ライブカラー（約1.5〜2秒保持）
44 03 01 01 00 <slot u16 LE> 00        1フレーム/1パケットのヘッダ
44 04 00 00 R G B                      フレーム0（応答 45 04）
42 02 <slot u16 LE> 06 <duration u16 LE>   FrameLightへ切替（応答 43 02）
```

slot 1 へアップロードしたFrameLightは電源再投入後も保持されます（上流資料で確認）。
本ソフトは Solid 選択時に slot 0 / slot 1 の両方へ書き込みます。

### DE FF 相当の保存

universalプロトコルには Haste 1 の `DE FF` のような単一保存コマンドはなく、
**slot 1 への書き込み**がオンボード保存を兼ねます。

## 非同期イベント（未使用）

- `fb 0a <0|1>` リンク切断/復帰
- `fb 08 <stage> <code u16 LE>` DPIボタンでステージ変更（DPI = (code+1)*50）
- `fb 01 <button> 00 <0|1>` ボタン押下/解放

本ソフトは `52 01` のポーリングでリンク状態を監視しているため、イベントは使いません。

## 実機検証ログ（2026-11-19）

- 読み取り: `10 01`, `52 01`, `50 02`（83% / 充電中 / 4177mV）、
  `32 02`（4ステージ、400/800/1600/3200、ステージ2がアクティブ、色は赤/青/黄/緑）、
  `36 02`（LOD 1mm）、`40 02`（生値41 → 16%）、`42 03`（FrameLight / duration 50）
- 書き込み: polling 1000→500→1000、DPI stage1 400→1200→400、
  ステージ数 4→5→4、現在ステージ 1→2→1、LOD 1→2→1、
  明るさ 16%→50%→16%、ライト Off→Solid→色 赤→白→Breath→Solid
- テスト後は元の状態（1000Hz / 4ステージ / 現在ステージ2=800DPI / LOD 1mm /
  明るさ16% / Solid 白 / 速度50）に復元
- パッケージ版（asar）でも接続・読み取りを確認

## 制限事項

- FrameLight の色そのものは `42 03` では読み戻せません。本ソフトは最後に設定した色
  （起動直後は白）を表示します。
- ライトの「カラーサイクル」はスペクトル固定で、カラー値は使いません。
- ボタン割り当て・マクロ・バッテリー警告しきい値は本プロファイルでは扱いません。
- ファームウェアは USB bcdDevice から表示しています（デバイス情報のファームウェア文字列は未解析）。
