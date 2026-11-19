# HyperX Pulsefire Haste Wireless — 解析記録

- 日付: 2026-11-19
- 状態: **プロファイル稼働中** (`devices/hyperx-pulsefire-haste-wireless.json`)
- 実機: HyperX Pulsefire Haste Wireless（HP Inc.）、2.4GHz ドングル接続
- USB: `03f0:028e`、Product string `HyperX Pulsefire Haste Wireless`
- 制御コレクション: interface 2 / usagePage `0xFF00` / usage 1
- レポート: **入力65バイト / 出力65バイト（レポートID 0 + 64バイト）**、Featureレポートなし
- ファームウェア: `v4.1.0.6`（0x50 応答の byte8..11 = 06 00 01 04）

## プロトコル出典

- [santeri3700/hyperx_pulsefire_dart_reverse_engineering](https://github.com/santeri3700/hyperx_pulsefire_dart_reverse_engineering)（CC0）
  — HyperX Pulsefire Dart の NGenuity2 プロトコル資料。Haste Wireless では
  0x50 / 0x51 / 0x52 の読み取りと D0 / D2 / DE の ACK を実機で確認し、
  D3 (DPI) は同資料のレイアウトを適用。
- 参考: [OpenRGB issue #2592](https://gitlab.com/CalcProgrammer1/OpenRGB/-/issues/2592)（`03f0:028e` の報告）

> 鳥瞰: 64バイトのコマンドフレームを出力レポートに書き、同じコマンド番号を先頭に持つ
> 64バイトの入力レポートが返ります。書き込み系は `cmd 00 00 02 EC ...` の ACK を返します。

## 読み取りコマンド（実機確認済み）

### 0x50 — ハードウェア情報

```
50 00 00 3c 8e 02 f0 03 06 00 01 04 8e 03 f0 03 03 00 01 00 "HyperX Pulsefire Haste Wireless" …
      ^^^^^ ^^^^^ ^^^^ ^^^^                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^
      PID   VID   fw(build/rev/minor/major)                    product string (byte 21〜)
```

- PID = `(byte5<<8)|byte4` = `0x028E`
- VID = `(byte7<<8)|byte6` = `0x03F0`
- ファームウェア = `v{byte11}.{byte10}.{byte9}.{byte8}` = **v4.1.0.6**
- 製品名は byte21 以降の NUL 終端 ASCII

### 0x51 — ハートビート / バッテリー

```
51 00 00 09 54 01 0a 18 00 64 10 02 04 …
            ^^ ^^
            |  charging (1 = 充電中)
            battery % (0x54 = 84)
```

- バッテリー: byte4（0〜100）
- 充電状態: byte5（0/1）
- 0x51 は接続維持も兼ねる。スリープ中でもドングルが応答

### 0x52 — LED設定の読み戻し

```
52 00 00 0a 00 00 00 64 ff ff ff ff ff ff 00 …
            ^^       ^^ ^^^^^^^ ^^^^^^^ ^^
            |        |  RGB1    RGB2    speed?
            |      brightness
            effect
```

Haste Wireless での読み戻しレイアウト:

| バイト | 内容 |
| --- | --- |
| 4 | effect（0x00=スタティック、0x04=LightSync既定、0x10/0x12=スペクトル、0x20=ブリージング、0x30=トリガーフェード） |
| 7 | 明るさ（0〜100） |
| 8〜10 | RGB1 |
| 11〜13 | RGB2（本ソフトはRGB1と同じ値を書き込み） |
| 14 | 速度（0〜100、効果依存） |

## 書き込みコマンド（実機でACK確認済み）

共通: 65バイト出力（`00` + 64バイト）。応答は `cmd 00 00 02 EC …`。

### D0 — ポーリングレート

```
D0 00 00 01 <code>
            code: 0=125Hz, 1=250Hz, 2=500Hz, 3=1000Hz
ACK: D0 00 00 02 EC 00 …
```

### D2 — LED

```
D2 <zone> <effect> 08 <R> <G> <B> <R2> <G2> <B2> <brightness> <speed>
   zone: 0x00 (単一ゾーン)
ACK: D2 00 00 02 EC AC …
```

### D3 — DPI

```
モード0（アクティブプロファイル）: D3 00 00 01 <index 0-4>
モード1（有効プロファイル）      : D3 01 00 01 <mask 1-31>
モード2（DPI値）                : D3 02 00 02 <lo> <hi>     ※ DPI/50 のLE16
モード3（ステージ色）           : D3 03 <index> 03 <R> <G> <B>
ACK: D3 00 00 02 EC …
```

- DPI範囲: 200〜16000、50刻み（公式仕様 16,000 DPI）
- 有効マスク: bit0 = ステージ1 … bit4 = ステージ5（`(1<<count)-1`）
- DPI値の読み戻しコマンドは存在しない（NGenuity2 は書き込み専用）

### DE FF — オンボードメモリへ保存

```
DE FF
ACK: DE FF 00 02 EC AC …
```

書き込み後は毎回 DE FF を送って永続化しています。

## 非同期イベント

```
FF 03 <profile> <cable> <wake> …
      ^^^^^^^^^ ^^^^^^^
      アクティブステージ ケーブル接続/充電
```

DPIボタンでステージを切り替えると届きます。本ソフトはこれでキャッシュの
`activeStage` を更新します。

## 制限事項

- **DPI・ポーリングレートは読み戻し不可**。本ソフトは `data/hyperx-pulsefire-haste-wireless.json`
  に最後に書き込んだ値をキャッシュして表示します（初回はプロファイル既定値）。
- LED設定とバッテリーは読み戻し可能です（0x52 / 0x51）。
- 有線接続時のIDは未確認（本プロファイルはドングル `0x028E` のみ対象）。
- ファームウェア更新機能はありません。

## 検証メモ

- 0x50 / 0x51 / 0x52 の読み取りを確認
- D0（1000Hz）、D2（赤→白）、D3（DPI 1200→400、ステージ色、有効数3/4、アクティブ0/1）、DE FF の応答を確認
- テスト後は **effect 4（LightSync既定）/ 白 / 明るさ100 / 1000Hz / ステージ1=400DPI** に復元
- 解析用スクリプト: `scripts/probe-hyperx.js`（`--write-test` は D0/D2/DE のみ。DPI書き込みは行わない）
