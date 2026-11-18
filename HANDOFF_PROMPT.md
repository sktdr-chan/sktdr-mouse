# 引継ぎプロンプト — Scyrox V8 対応 汎用マウス設定ソフトウェアの再実装仕様

> **使い方**: このドキュメントを丸ごとAIエージェント（または開発者）に渡し、
> 「この仕様に従って ○○（Python / C# / Rust / Go など）で実装してください」と指示してください。
> プロトコル仕様・実装上の知見・アーキテクチャ・テスト手順・出典がすべて含まれており、
> このファイル単体で完全な再実装が可能です。

> **他プロトコルファミリー**: 本仕様は Compx系（Scyrox/Lamzu, §4〜§10）を収録しています。
> 実装済み参考コードにはさらに3ファミリーがあります —
> **Darmoshark (Nordic系MOJI, 64バイトコマンドフレーム・チェックサム0xA1)** は
> `research/darmoshark-m5.md`、**Logitech HID++ 2.0 (機能インデックス解決＋20バイト長報告)** は
> `research/logitech-hidpp.md`、**ROCCAT Swarm形式** は `research/roccat-kone-pro-air.md` を
> それぞれ参照してください（アダプターの書き込みモード — フラッシュマップ /
> コマンドフレーム / 固定シーケンス / HID++機能呼び出し — は §12 の構成図を参照）。

---

## 1. 目標と成果物

Scyrox V8（Compx製ワイヤレスゲーミングマウス）を対象に、公式ドライバー相当の設定ソフトウェアを作る。

**必須のアーキテクチャ要件** — 「1つのソフトで複数機種を設定できる」構造:

```
┌─────────────────────────────────────────────┐
│ UI (スキーマ駆動: プロファイルJSONから自動生成)  │
├─────────────────────────────────────────────┤
│ HTTP API + SSE(イベントストリーム)             │
├─────────────────────────────────────────────┤
│ core (汎用):                                 │
│   DeviceManager … プロファイル⇔実機のマッチング │
│   Adapter      … 設定の読み書きエンジン         │
│   Transport    … HIDパケット送受信・再送        │
│   Codec        … 値のエンコード/デコード        │
├─────────────────────────────────────────────┤
│ devices/*.json (マウス固有) ← 差し替え可能      │
└─────────────────────────────────────────────┘
```

- **マウス固有の知識（VID/PID、パケットフォーマット、チェックサム、コマンド表、フラッシュマップ、値エンコード、UIスキーマ）はすべてデバイスプロファイルJSONに書く**
- core はプロファイルJSONのみを解釈して動作する。新しいマウスの追加＝JSONファイルを `devices/` に置くだけ（コード変更不要）
- 参考実装（Node.js版）のプロファイル実物: `devices/scyrox-v8.json`

## 2. 前提環境

- Windows 10/11（HID直接通信。macOS/Linuxでもhidapi経由で可能）
- 実機検証に使った環境: Node.js 24 + node-hid 3.4 (hidapi), SCYROX 8K Dongle (VID 0x3554 / PID 0xF5F7), ドングルFW v2.17, マウスFW v2.22
- 言語別のHIDライブラリ例: Python=`hid` (hidapi), C/C++=hidapi, C#=HidLibrary / hidsharp, Rust=`hidapi`クレート, Go=`karalabe/hid` (hidapiバインディング)

## 3. 出典（必ず成果物に明記すること）

| 出典 | 内容 |
| --- | --- |
| **https://github.com/azais-corentin/scyrox** | プロトコル仕様書 `docs/protocol.md`（『Scyrox Mouse HID Communication Protocol Specification』）とRust参照実装。本仕様の一次情報源 |
| https://github.com/zzy6-a/ScyroxTray | 旧世代 V6/V8 (VID_3554) と新世代 V6S/V8S (VID_395A) の2系統プロトコルが存在することの確認資料 |
| https://github.com/mikezom/scyrox-v6-battery-plasmoid | V6のバッテリー取得実装 |

> 注意: 本仕様はコミュニティによるリバースエンジニアリング成果を基に、実機で読み書きを検証して補正したものである。
> 一次情報源の `docs/protocol.md` との差分（§10「実機で確認した注意点」）を特に参照のこと。

## 4. デバイス検出 (USB/HID)

| 項目 | 値 |
| --- | --- |
| Vendor ID | `0x3554` (Compx) |
| Product ID | `0xF5F7` (8Kドングル) / `0xF5F4` (標準ドングル) / `0xF5F6` (有線) |
| HID構成 | 複合デバイス。MI_00=キーボード, MI_01=8個のトップレベルコレクション（うちベンダー定義は usagePage `0xFF02`,`0xFF03`,`0xFF04`,`0xFF05`,`0xFF06`）, MI_02=マウス |
| 制御コレクション | **usagePage >= 0xFF00 のコレクションを順に開き、GetDongleVersion (0x1D) を送って応答が返るもの**。実機では usagePage `0xFF02` (usage 0x02) が応答した |

検出手順:
1. HIDデバイスを列挙し VID/PID でフィルタ
2. usagePage >= 0xFF00 のコレクションのみ候補とする（マウス/キーボード/コンシューマコレクションは開けないか意味がない）
3. 各候補を開いて `GetDongleVersion` を送信（タイムアウト250ms×1回）→ 応答したらそれが制御チャネル
4. キーボード(MI_00)/マウス(MI_02)は保護されており開けない場合がある → 例外を握り潰して次へ

## 5. パケットフォーマット

**レポートID = 8 (0x08)、固定長16バイト**。書き込み時は先頭にレポートIDを付けて17バイトをHID出力レポートとして送る。読み取り時もレポートIDが先頭に付いて返る（プラットフォームによっては付かない実装もあるため、先頭バイト==8かつ長さ>=17ならstripする正規化を推奨）。

```
オフセット  フィールド
---------  ---------------------------
0          コマンドID
1          予約 (0x00) ※応答ではステータス (0=成功, 1=エラー/非対応)
2          アドレス上位バイト (フラッシュ操作時)
3          アドレス下位バイト (フラッシュ操作時)
4          データ長 (最大10)
5〜14      データペイロード (10バイト)
15         チェックサム
```

**チェックサム**（実機検証済み）:

```
checksum = (0x55 - (bytes[0..14]の総和 & 0xFF) - レポートID(8)) & 0xFF
```

応答パケットも同じ計算式で検証できる。

**応照合（リトライ判定）**: ReadFlash (0x08) は要求のバイト0〜4がそのままエコーされることを確認。その他のコマンドはバイト0（コマンドID）が一致すればよい（バイト1はステータスなので、失敗応答も受け取れるように比較から除外する）。

## 6. コマンド一覧

| ID | 名称 | 方向 | 内容 |
| --- | --- | --- | --- |
| 0x01 | EncryptionData (ハンドシェイク) | 双方向 | データ長8、データ[0..3]=乱数4バイト+ゼロ4バイト。応答: byte9=CID(62), byte10=MID(1), byte11=接続タイプ |
| 0x02 | PCDriverStatus | ホスト→機器 | データ長1、データ[0]=1(接続)/0(切断)。ドライバーの生存をマウスに通知、無線リンクを維持 |
| 0x03 | DeviceOnLine | 双方向 | 応答: byte5=オンライン(1/0), byte6/7/8=デバイスアドレス(逆順) |
| 0x04 | BatteryLevel | 双方向 | 応答: byte5=残量%, byte6=充電中(1/0), byte7-8=電圧mV(ビッグエンディアン) |
| 0x05 | DongleEnterPair | ホスト→機器 | データ長2だがデータ3バイト: `[0x00, 0x00, 0x3E]`（0x3E=62秒はbyte7位置）。ドングルをペアリングモードへ |
| 0x06 | GetPairState | 双方向 | byte5=状態(0=待機,1=ペアリング中,2=失敗,3=成功), byte6=残り秒 |
| 0x07 | WriteFlashData | ホスト→機器 | アドレス(byte2-3)+長さ(byte4)+データ(byte5-) |
| 0x08 | ReadFlashData | 双方向 | アドレス(byte2-3)+長さ(byte4)。応答のbyte5〜にデータ |
| 0x09 | ClearSetting (工場リセット) | ホスト→機器 | 送信後〜1.3秒待ってから再初期化 |
| 0x0A | StatusChanged | 機器→ホスト | **一方的通知**（マウス本体ボタンで設定変更時）。byte5=フラグビットマスク（下記） |
| 0x0E | GetCurrentConfig | 双方向 | byte5=アクティブプロファイル番号 (0〜3) |
| 0x0F | SetCurrentConfig | ホスト→機器 | データ長1、データ[0]=プロファイル番号 |
| 0x12 | ReadVersionID (マウスFW) | 双方向 | byte5=メジャー(10進), byte6=マイナー(BCD/16進2桁)。`v{major}.{minor:02x}` 形式（例: 2,0x20→v2.20） |
| 0x16 | SetLongRangeMode | ホスト→機器 | データ長10、データ[0]=1/0 |
| 0x17 | GetLongRangeMode | 双方向 | byte5=有効(1)/無効(0)。**ステータス(byte1)=1なら非対応ファームウェア** |
| 0x1D | GetDongleVersion | 双方向 | 応答レイアウトは0x12と同じ。検出プローブにも使える |

**StatusChanged フラグビット** (byte5):

| ビット | 意味 | 対応 |
| --- | --- | --- |
| 0x01 | 現在のDPIステージ変更 | アドレス0x0004を再読込 |
| 0x02 | ポーリングレート変更 | アドレス0x0000を再読込 |
| 0x04 | プロファイル変更 | 0x0Eを再発行 |
| 0x08 | DPI設定変更 | 0x000C〜0x004Bを再読込 |
| 0x20 | ライト設定変更 | 0x00A0〜を再読込 |
| 0x40 | バッテリー状態変更 | 0x04を再発行 |

通知を受信したらフラグに応じて（簡略化するなら全部）設定を再読込してUIへ反映する。

## 7. フラッシュメモリマップ（設定領域 0x0000〜0x00FF）

| アドレス | サイズ | 設定 | エンコード |
| --- | --- | --- | --- |
| 0x0000 | 1 | ポーリングレート | 下記§8 |
| 0x0002 | 1 | DPIステージ数 (1〜8) | 生値 |
| 0x0004 | 1 | 現在のDPIステージ (0〜7) | 生値 |
| 0x0006 | 2 | 予約 | — |
| 0x0008 | 1 | 20Kセンサーモード | 0/1 |
| 0x000A | 1 | LOD | 3=0.7mm, 1=1mm, 2=2mm |
| 0x000C | 32 | DPI値 8ステージ×4バイト | 下記§8 |
| 0x002C | 32 | DPI色 8ステージ×4バイト | RGB+補数 |
| 0x004C | 2 | DPIエフェクト モード | 0=Off,1=常時,2=ブリージング |
| 0x004E | 2 | DPIエフェクト 輝度 | 輝度テーブル（§8） |
| 0x0050 | 2 | DPIエフェクト 速度 | 1〜10 |
| 0x0052 | 2 | DPIエフェクト 有効 | 0/1 |
| 0x0060 | 32 | ボタン機能 8キー×4バイト | （本実装では未対応。仕様は出典§6.10参照） |
| 0x00A0 | 7 | ライト: [モード,R,G,B,速度,輝度,予約] | モード: 0=Off,1=カラーフロー,2=単色ブリージング,3=常時(単色),4=ネオン,5=混色ブリージング,6=常時(フルカラー)。**輝度は0〜255生値**（§10参照） |
| 0x00A7 | 1 | ライト ON/OFF | 0/1 |
| 0x00A9 | 1 | デバウンサ | 0〜30 (ms) |
| 0x00AB | 1 | モーションシンク | 0/1 |
| 0x00AD | 1 | スリープ時間 | コード表（§8） |
| 0x00AF | 1 | アングルスナップ | 0/1 |
| 0x00B1 | 1 | リップルコントロール | 0/1 |
| 0x00B3 | 1 | ムービングオフライト | 時間値 |
| 0x00B5 | 1 | パフォーマンスモード | 0/1 |
| 0x00B7 | 1 | パフォーマンス時間 | コード表（§8） |
| 0x00B9 | 1 | センサーモード | 0=LP(省電力), 1=HP(高性能) |
| 0x0100〜0x01FF | 256 | ショートカットキー 8スロット×32バイト | 出典§6.13 |
| 0x0300〜0x0BFF | 3072 | マクロ 8スロット×384バイト | 出典§6.14 |

## 8. 値エンコード

**ポーリングレート (0x0000)**:

```
<=1000Hz : 生値 = 1000 / Hz      (125→8, 250→4, 500→2, 1000→1)
>1000Hz  : 生値 = (Hz/2000)×16   (2000→16, 4000→32, 8000→64)
逆変換: 生値>=16 → (生値/16)×2000, それ以外 → 1000/生値
```

**DPI値 (4バイトレコード)** — 範囲50〜26000、50刻み:

```
enc  = DPI/50 - 1
low  = enc & 0xFF
high = (enc >> 8) & 0x03
byte0 = low            // 2重化
byte1 = low
byte2 = (high << 2) | (high << 6)
byte3 = (0x55 - (byte0+byte1+byte2)) & 0xFF
逆変換: high=(byte2&0x0C)>>2; val=byte0|(high<<8); DPI=(val+1)*50
```

**DPI色 (4バイトレコード)**: `[R, G, B, (0x55-(R+G+B))&0xFF]`

**スリープ/パフォーマンス時間コード表**:
`1=10秒, 3=30秒, 6=1分, 30=5分, 60=10分, 180=30分`

**輝度テーブル（DPIエフェクト用）**: レベル1〜10 ↔ `[16,30,60,90,128,150,180,210,230,255]`

**接続タイプ (ハンドシェーク byte11)**:

| 値 | 接続 | 最大Hz |
| --- | --- | --- |
| 0 | ワイヤレス標準 | 1000 |
| 1 | ワイヤレス 4K | 4000 |
| 2 | 有線標準 | 1000 |
| 3 | 有線 8K | 8000 |
| 4 | ワイヤレス 2K | 2000 |
| 5 | ワイヤレス 8K | 8000 |

UIではこの最大Hzを超えるポーリングレートを選択不可にする。

## 9. 通信シーケンス

**初期化**（順番に実行）:

```
1. 制御コレクションを開く（§4の方法）
2. GetDongleVersion (0x1D)
3. DeviceOnLine (0x03) を1.5秒間隔でポーリング → byte5==1 になるまで
   （マウスがスリープ中は0のまま。物理的に動かすまで起きない）
4. PCDriverStatus (0x02) に1を送信（無線リンク維持）
5. ハンドシェイク (0x01) → CID/MID/接続タイプ取得
6. フラッシュ0x0000〜0x00FFを10バイトずつ読み込み（0x08を26回）
7. GetCurrentConfig (0x0E)、ReadVersionID (0x12)、
   GetLongRangeMode (0x17)（非対応なら非表示）
8. BatteryLevel (0x04)
```

**書き込み（1バイト設定）** — 補数形式を使う:

```
コマンド0x07、アドレス+データ長2、データ = [value, (0x55 - value) & 0xFF]
```

**書き込み（複数バイト、DPI等）**: データ長=バイト数でそのまま書く。

**運用**:

- すべてのコマンドはタイムアウト250〜300ms・再試行3回
- **書き込みの直前に DeviceOnLine (0x03) を1回送る（ステータス同期）** — 参照実装の慣行。実機では無しでも動くが入れること
- コマンドは直列に実行（1つずつ）。バッテリーは10秒周期、オンライン状態は5秒周期でポーリング
- 終了時は PCDriverStatus に0を送信してから閉じる
- ホットプラグ: デバイス喪失を検知したら1〜2秒周期で再列挙→再初期化
- マウスはアイドルでスリープする。UIは「スリープ中」状態を表示し、応答が返り次第自動再開

## 10. 実機で確認した注意点（出典仕様との差分・知見）

1. **メインライトの輝度 (0xA5) は0〜255の生値**。出典の輝度テーブルはDPIエフェクト (0x004E) 専用。参照実装 (Rust) の `get_light_settings` も生値として扱っている。実機の初期値は9だった
2. ハンドシェークの乱数は**そのままエコーされず変換されて返る**（例: `12 34 56 78` → `84 bf 7a f2`）。エコー一致検証をしてはならない
3. 応答待ち中に一方的通知 (0x0A) が割り込むことがある → コマンドIDが一致しないパケットは通知として処理し、応答待ちを継続する
4. Windowsでは同一VID/PIDで複数のベンダー定義コレクションが開ける。**プローブ (0x1D) に応答するコレクションを探して1つだけ使う**
5. node-hid (hidapi) の read 系は生値の配列を返す（Bufferと仮定しない）
6. 工場リセット (0x09) 後は〜1.3秒待ち、オンライン待ち→全再読込が必要
7. スリープ中はフラッシュ読み書きがタイムアウトする（ドングル系コマンド 0x1D/0x03 は応答する）。エラー処理と「スリープ解除を促すUI」が必須
8. ペアリング (0x05) はデータ長2だが実際に意味があるのはbyte7位置の0x3E（62秒タイムアウト）— 出典仕様どおりの微妙な形式
9. GetLongRangeMode は非対応ファームウェアでステータス1を返す → UIでは「非対応」として項目を隠す

## 11. デバイスプロファイルJSONのスキーマ（マウス固有部分）

`devices/` に置くJSON。core はこの形式だけを解釈する。Scyrox V8の実物（`scyrox-v8.json`）が最良の例。

```jsonc
{
  "profileVersion": 1,
  "id": "一意なID",
  "_documentation": {          // 出典・検証情報（UIにも表示する）
    "protocolSource": "https://github.com/azais-corentin/scyrox — docs/protocol.md",
    "verifiedOn": "...",
    "additionalReferences": []
  },
  "meta": { "name": "表示名", "brand": "ブランド", "models": [], "notes": "" },
  "usb": {
    "vendorId": "0x3554",                       // 16進文字列可
    "productIds": ["0xF5F6", "0xF5F7", "0xF5F4"],
    "vendorUsagePageMin": "0xFF00",             // コレクション候補の条件
    "probeCommand": "dongleVersion"             // commands内の名前
  },
  "transport": {
    "reportId": 8, "packetLength": 16,
    "layout": { "command":0, "status":1, "addressHi":2, "addressLo":3,
                "length":4, "data":5, "dataMax":10, "checksum":15 },
    "checksum": { "algorithm": "subtract-from-sum", "base": "0x55", "subtractReportId": true },
    "singleByteWrite": { "dataLength": 2, "complementBase": "0x55" },
    "readChunk": 10,
    "configImage": { "start": "0x0000", "length": 256 },
    "statusSyncBeforeWrite": "deviceOnline",     // 書き込み前に送るコマンド名
    "unsolicited": { "command": "statusChanged", "flagsOffset": 5 }
  },
  "commands": {
    "コマンド名": { "id": "0x1D", "dataLength": 1,
                    "data": ["0x00","0x00","0x3E"],   // 固定データ（省略可）
                    "response": { "フィールド名": オフセット },  // 汎用パーサ用
                    "settleMs": 1300 }                  // リセット後の待ち
  },
  "connectionTypes": { "5": { "label": "ワイヤレス 8K", "maxHz": 8000 } },
  "statusFlags":   { "0x01": "表示メッセージ", "..." : "..." },
  "ui": {
    "deviceInfo": [ { "key": "product", "label": "製品" }, ... ],
    "sections": [
      { "title": "センサー設定",
        "settings": [
          { "key": "lod", "type": "segmented", "label": "LOD",
            "read":  { "address": "0x000A", "bytes": 1,
                       "codec": { "type": "enum", "values": [
                          {"value": 0.7, "code": 3, "label": "0.7 mm"}, ... ] } },
            "write": { "mode": "singleByte" } },
          { "key": "dpi", "type": "dpiStages", "maxRecords": 8,
            "count":   { "read": {"address":"0x0002","codec":"byte"}, "write": {"mode":"singleByte"} },
            "current": { "read": {"address":"0x0004","codec":"byte"}, "write": {"mode":"singleByte"} },
            "value":   { "read": {"address":"0x000C","stride":4,"bytes":4,
                                   "codec":{"type":"dpi","step":50,"min":50,"max":26000}},
                          "write": {"mode":"bytes"} },
            "color":   { "read": {"address":"0x002C","stride":4,"bytes":4,
                                   "codec":"rgbComplement"}, "write": {"mode":"bytes"} } },
          { "key": "light", "type": "group",           // 7バイトブロックを合成して書く
            "block": { "address": "0x00A0", "length": 7 },
            "fields": [ { "key":"mode", "type":"select", "read":{"offset":0,"codec":{...}},
                          "writeOffset": 0 }, ... ],
            "on":     { "key":"on", "type":"toggle", "read":{"address":"0x00A7","codec":"bool"},
                        "write":{"mode":"singleByte"} } },
          { "key": "profileIndex", "type": "segmented",
            "read":  { "command": "getProfile", "field": "profile" },   // コマンド駆動設定
            "write": { "command": "setProfile", "argIndex": 0 },
            "options": [ {"value":0,"label":"プロファイル 1"}, ... ] }
        ],
        "actions": [
          { "key": "factoryReset", "type": "button", "danger": true,
            "command": "factoryReset", "doubleClickConfirm": true },
          { "key": "pairing", "type": "button", "command": "enterPair",
            "confirm": "確認ダイアログ文案", "successMessage": "完了トースト文案" }
        ] }
    ]
  }
}
```

**コーデック一覧**（core/codec.js 相当）:

| type | 概要 |
| --- | --- |
| `byte` | 生バイト |
| `bool` | 0/1 → 真偽 |
| `enum` | `values: [{value, code, label}]` の対応表 |
| `rgb` | [r,g,b] 3バイト |
| `rgbComplement` | [r,g,b] + 補数 `(0x55-(r+g+b))` の4バイトレコード |
| `dpi` | §8のパック形式（step/min/maxパラメータ付き） |

新しいマウスが特殊なエンコードを持つ場合のみ、コーデックを1つ追加する（他はすべてJSONで済む）。

## 12. 参考実装（Node.js版）の構成

```
server.js            HTTP+SSEサーバー (localhost:3554)。 /api/schema /api/config
                     /api/apply {setting,args} /api/action {action,args} /api/events
core/profile.js      devices/*.json のロード・バリデーション
core/manager.js      プロファイル⇔実機マッチング、ホットプラグ、状態通知
core/transport.js    HID送受信（コマンドキュー・再送・チェックサム・通知処理）
core/adapter.js      設定の読み書きエンジン（プロファイル解釈）
core/codec.js        値コーデック
devices/scyrox-v8.json  Scyrox V8 固有定義（唯一のマウス依存ファイル）
public/              スキーマ駆動UI（プロファイルから全画面を自動生成）
scripts/probe.js     単体診断ツール（読み取りのみ／--write-testで現在値書き戻し）
```

APIプロトコル（UI⇔サーバー）:

- `GET /api/schema` — プロファイルのUIスキーマ（UIはこれだけで全画面を構築）
- `GET /api/status` — 接続状態・バージョン・バッテリー
- `GET /api/config` — パース済み設定一式
- `POST /api/apply` `{setting, args}` — 設定書込（argsは設定タイプ毎に§11の形式）
- `POST /api/action` `{action, args}` — 工場リセット/ペアリング等
- `GET /api/events` — SSE: `status` / `config` / `battery` / `online` / `notification` / `waiting` イベント

## 13. テスト手順と合格基準

**段階1 — 読み取りのみ**:

1. 制御コレクションを検出できること
2. ハンドシェークで CID=62, MID=1, 接続タイプ=5（8Kドングル時）が取れること
3. フラッシュ0x0000〜0x00FFを全読みできること
4. ポーリングレート/DPIステージ/LOD/デバウンサ等が仕様どおりパースできること
5. バッテリー残量・電圧（mV）が取れること

**段階2 — 書き込み（変化を与えない検証）**:

1. 現在のDPIステージ番号をそのまま書き戻す（1バイト+補数）→ ACK
2. 現在のDPI値（例: stage1=800dpi）をそのまま書き戻す（4バイト）→ ACK後、読み返して一致
3. 現在のポーリングレートをそのまま書き戻す → ACK
4. 現在のプロファイル番号をそのまま書き戻す → ACK

**段階3 — UI結合**:

1. スリープ中のマウスに「スリープ解除を促す」表示が出ること
2. マウスを動かすと5秒以内にUIが有効化し設定が表示されること
3. UI操作で書き込み→保存完了表示→再読込で値が一致
4. マウス本体のDPIボタンを押すとUIに自動反映されること（0x0A通知→再読込）

**安全規則**: テストは必ず「現在値の書き戻し」で行う。公式ソフト/アップデータとの同時実行を禁止。破壊的操作（工場リセット）はUIで二重確認を必須にする。

## 14. ライセンス・表記義務

- プロトコル仕様の出典（azais-corentin/scyrox、必要に応じてScyroxTray等）をREADME・UI・プロファイルJSONに明記すること
- 本ドキュメント自体は再実装成果物に同梱してよい
- 非公式ツールであること（メーカー保証外の設定変更である旨をREADMEに記載）

---

*最終検証: 2026-11-18, SCYROX 8K Dongle (0x3554:0xF5F7), dongle FW v2.17 / mouse FW v2.22 にて読み書き動作確認済み。*
