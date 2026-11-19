# sktdr-mouse — プロファイル駆動・5プロトコルファミリー対応

プロファイル駆動型のマウス設定ソフトウェアです。**本体（core）はマウス非依存**で、
マウス固有の知識はすべて `devices/` 内のJSONプロファイルに記述されます。
新しいマウスはJSONファイルを置くだけで追加できます。

**UIは日本語・English・中文の3言語対応**（⚙管理 → 表示言語で切り替え）。明るいライトテーマです。

> ⚠️ **免責事項**: 本ソフトは**非公式・無保証**です。各メーカーとは提携・承認・後援関係がなく、
> プロトコル実装は公開情報・コミュニティ解析・独自キャプチャに基づく独立実装です。
> 設定の書き込みは**自己責任**で行ってください。全文は **[DISCLAIMER.md](DISCLAIMER.md)** を必ずお読みください。

| 対応機種 | 接続 | 実装方式 |
| --- | --- | --- |
| **Compx系汎用** (VID 0x3554) — Scyrox V8 / Scyrox V6 / Lamzu Maya / VXE R1 Pro Max 等 | 8K・標準・1Kドングル / 有線 | HIDフラッシュマップ直接読み書き。VID一致で自動検出し、ハンドシェークのMIDで機種名を表示（V8=1, V6=2, Maya=4, R1 Pro Max=34。未知のMIDもHID製品名で動作） |
| **VXE MAD R Major** (VID 0x373B) | 8Kドングル / 有線 | Scyrox系と同一パケット形式（16バイト・チェックサム共通）だがページ方式メモリマップ。X/Y独立DPI、スリープ確認書き込みに対応 |
| **Darmoshark M5** (VID 0x1915) | 8Kドングル (PID 0x0725) / 1Kレシーバー (0x0723) | Nordic系「MOJI」コマンドフレーム方式（レポートID 0x00 + 64バイト、チェックサム0xA1）。ドングルがマウスのスリープ中も全コマンドに応答 |
| **Logitech G PRO X Wireless** (VID 0x046D) | Lightspeedレシーバー (PID 0xC547) | **HID++ 2.0**（機能インデックス解決＋20バイト長報告）。DPI・レートはホストモードでライブ適用 |
| **Razer DeathAdder V3 Pro** (VID 0x1532, 有線) | USB有線 | **Razer 90バイトfeatureレポート**（openrazerプロトコル）。DPIステージ・レート・スリープ時間を即時適用・永続化 |
| **ROCCAT Kone Pro Air** (有線, VID 0x1E7D) | USB有線 | Swarm通信をキャプチャ解析した12コマンド適用シーケンス |

> Compx系の詳細（作者が実機確認したモデル／動作する可能性が高いモデル／別プロトコル機種）は
> 下の「Compx系の対応状況」を参照してください。

## UIの特徴（マウス管理）

- **ビルド情報の表示** — ヘッダーにビルド元コミットの短縮ID（例: `4bad54c`）を表示。⚙管理ダイアログにはコミット・ビルド日時・Electronバージョンを表示
- **デバイス情報とログは左レールに配置** — ログはデバイス情報の直下でスクロールに追従（sticky）するため、下の設定を変更した結果をその場で確認できます
- **上部には接続中のマウスだけを表示** — 切断・スリープ中は灰色チップ、1分間オンラインに戻らなければ自動で消える
- **設定画面を開いているマウスは極太の黒枠**で強調、他のオンラインマウスは淡い緑
- **⚙ 管理メニュー**で全対応機種を一覧表示（接続状態・バッテリー残量）。そこから選択して切り替え、表示言語も変更可能
- **数値入力つきスライダー**、**即時適用↔保存ボタン切替**（変更を保留してまとめて適用するモード、localStorageで保持）

（参考: 次世代の Scyrox V6S/V8S は VID 0x395A・別プロトコルで未対応 — 対応するには新しいプロファイルとトランスポートの追加が必要）

## Compx系（VID 0x3554）の対応状況

Compx系チップ（VID `0x3554`）は**同じVIDでも複数のプロトコル**が存在します。本ソフトが扱うのは、
**16バイト・レポートID 8・チェックサム `0x55` 系**の旧世代Compxプロトコルです。
接続時にドングルバージョン照会 (`0x1D`) とハンドシェイク (`0x01`) を行い、応答した場合のみ設定画面を表示します。

### 作者が実機で動作確認したモデル

| モデル | 接続 | 確認内容 |
| --- | --- | --- |
| **Scyrox V8** (MID=1) | 8Kドングル `0x3554:0xF5F7` / 有線 | 読み書き確認（ドングルFW v2.17 / マウスFW v2.22） |
| **Scyrox V6** (MID=2) | 8K・標準ドングル / 有線 | 読み書き確認 |
| **Lamzu Maya** (MID=4) | LAMZU Pro 1K Receiver | 読み書き確認 |
| **VXE R1 Pro Max** (MID=34) | VXE NordicMouse 1K Dongle (FW v1.21) | フラッシュマップ同一、書き込みACK・読み戻し確認 |

> 上記は `devices/compx-generic.json` の `verifiedOn` / `knownMids` に記録された内容です。

### 同一プロトコルで動作する可能性が高いモデル（未検証）

| モデル | 接続例 | 期待度 | 根拠・備考 |
| --- | --- | --- | --- |
| VXE R1 SE+ | `0x3554:0xF58E` (1K receiver) / `0xF58F` (wired) | 中 | OpenMouseではCOMPX系、LinuxカーネルではATK/Pulsar系として扱われる。**報告が混在**しており要検証 |
| Lamzu Thorn | Compx (PID未確定) | 高 | OpenMouseで「CompX protocol implemented」と記載 |
| Lamzu Atlantis系 (OG V2 / Mini / Mini Pro / Paro) | `0xF50F` (wired) / `0xF50D`, `0xF510` (receivers) | 中 | OpenMouseで同一ファミリのIDを確認。FW・個体差に注意 |
| Gravastar Mercury M1 Pro | `0xF54B/0xF575/0xF548/0xF577` (wireless), `0xF576/0xF549` (wired) | 高 | OpenMouseで「Pulsar/Compx **report-8** protocol」と記載 |
| E-YOOSO X-44 Pro+ (8K) | `0x3554`（PIDはリビジョン違い） | 中 | コミュニティでCompx系として動作報告（ClickSync） |
| その他の旧世代Compx機 | `0x3554` | 自動判定 | `0x1D` 照会＋`0x01` ハンドシェイクに応答すれば設定可能 |

> 「高」はプロトコル一致の報告があるもの、「中」はファミリ・VID一致レベルのものです。
> **いずれも作者の実機検証はありません。** 書き込み前に読み取りのみで確認してください。

### VID 0x3554 でも別プロトコルのため対象外

| モデル | 理由 |
| --- | --- |
| Scyrox V6S / V8S（新世代） | VID `0x395A`・64バイトの別プロトコル（本プロファイル対象外）。0x3554のV8S報告もあり要検証 |
| VXE Dragonfly R1 Pro | LinuxカーネルではKysona/Pulsar系プロトコルとして扱われる |
| Pulsar X2 / X2H / X2A / Xlite V3 | `0x3554:0xF507/0xF508/0xF509` だがPulsar独自プロトコル |
| Kysona M600 | Kysona独自プロトコル |
| Lamzu Maya X | Lamzu独自ドライバ/VID系の可能性が高く、本プロファイル対象外 |
| Dark Project Novus | `0x3554:0xFB0A` だがNordic系・プロトコル未解明 |

> 同じ型番でもファームウェアや出荷時期でプロトコルが異なる報告があります。
> 実機で `0x1D` 照会に応答しない場合は、その個体は本ソフトの対象外です。

出典:
- [OpenMouse — Supported Devices](https://openmouse.app/supported)（Compx系のPID・対応状況）
- [Linux kernel — HID: Kysona: Add support for VXE Dragonfly R1 Pro](https://lkml.iu.edu/2603.3/02147.html)
- [Linux kernel — HID: pulsar（VXE R1 SE+ / ATK の記述）](https://lists.openwall.net/linux-kernel/2026/08/25/835)
- [libratbag #1828 — Dark Project Novus (Compx 0x3554:0xFB0A)](https://github.com/libratbag/libratbag/issues/1828)
- [Reddit — E-YOOSO X-44 Pro+ (Compx generic)](https://www.reddit.com/r/MouseReview/comments/1u8g81j/got_my_unsupported_eyooso_x44_pro_trimode_8k/)

> VIDが同じでも別プロトコルの機種があります。接続しても設定画面が出ない場合は、その機種は本ソフトの対象外です
> （本ソフトは応答しないデバイスに対して書き込みを行いません）。

## プロトコル出典（大事な引用情報）

本ソフトウェアの通信プロトコルは、コミュニティによるリバースエンジニアリング成果と独自キャプチャ解析を基に、実機で読み書きを検証して実装しています。再実装・再配布の際は必ず出典を明記してください。

| 対応機種 | 出典 |
| --- | --- |
| Compx系 (Scyrox V8/V6, Lamzu Maya, VXE R1 Pro Max) | **[azais-corentin/scyrox](https://github.com/azais-corentin/scyrox)** — `docs/protocol.md`（一次情報源）、[zzy6-a/ScyroxTray](https://github.com/zzy6-a/ScyroxTray)、[mikezom/scyrox-v6-battery-plasmoid](https://github.com/mikezom/scyrox-v6-battery-plasmoid) |
| VXE MAD R Major | **[dkbednarczyk/madr](https://github.com/dkbednarczyk/madr)** (Apache-2.0) — madr-lib全モジュールをプロトコル参照として使用 |
| Darmoshark M5 | **公式ウェブドライバー (darmoshark.cc) のAngularバンドル逆解析** + 実機検証（`research/darmoshark-m5.md` に全記録）。参照: [ayasaki-exs/darmoshark-battery](https://github.com/ayasaki-exs/darmoshark-battery) — `docs/PROTOCOL.md`（1Kレシーバー 1915:0723 の電源プロトコル文書。フレーム形式・チェックサム0xA1・2.4GHzビットの一次確認源）、[mark2712/darmoshark_m5_air](https://github.com/mark2712/darmoshark_m5_air)（公式ドライバーのオフラインミラー — コマンド実装抽出に使用） |
| Logitech G PRO X Wireless | **HID++ 2.0公開仕様 + コミュニティ実装**（`research/logitech-hidpp.md` に全記録）。参照: [pwr-Solaar/Solaar](https://github.com/pwr-Solaar/Solaar) (GPL) — `hidpp20_constants.py` の機能ID表と `settings_templates.py` のファンクション番号・応答レイアウト（一次情報源）、[libratbag/libratbag](https://github.com/libratbag/libratbag) (MIT) — ONBOARD PROFILES構造、[Ad1FPS/Featherweight](https://github.com/Ad1FPS/Featherweight) (MIT) — ワイヤー形式（レポートID 0x11・swId・エラーフレーム処理）の確認源 |
| Razer DeathAdder V3 Pro | **openrazer (GPL-2.0)** — `driver/razercommon.c`（レポート形式・CRC・応答status）、`driver/razerchromacommon.c`（コマンド定義）、`driver/razermouse_driver.c`（機種別コマンド選択・transaction id）。本実装はopenrazerをプロトコル文書として参照する独立実装 |
| ROCCAT Kone Pro Air | **独自リバースエンジニアリング**（ROCCAT Swarm ↔ 本機のUSB通信キャプチャ、`research/roccat-kone-pro-air.md` に全記録）。参照: [Tobbesson/roccat-konepro-linux](https://github.com/Tobbesson/roccat-konepro-linux)（兄弟機のDPI÷50エンコード）、[mattiasdjarv/kone-battery](https://github.com/mattiasdjarv/kone-battery)（ドングルの90 0Aバッテリーパケット）、[FortisVoluntas/roccat-burst-pro-air-linux-tool](https://github.com/FortisVoluntas/roccat-burst-pro-air-linux-tool)（解析手法の参照元） |

> 出典仕様と実機の差分（メインライト輝度がテーブル変換なしの生値0〜255である点など）は
> `HANDOFF_PROMPT.md` §10 にまとめています。

## 対応環境

- Windows 10 / 11（HIDで直接通信します）
- Node.js 18以上（開発は Node 24 で確認）
- Scyrox V8 のUSBドングル接続（有線 PID `0xF5F6`・通常ドングル PID `0xF5F4` にも対応）

## 使い方

### ブラウザ版（開発向け）

```powershell
npm install
npm start
```

起動すると既定のブラウザで `http://localhost:3554` が開きます。終了は `Ctrl+C` です。

### Electron版（フォルダ配布）

ネイティブウィンドウで動く配布版です。**公式Electronバイナリをそのまま同梱**するフォルダ形式で、
配布用ZIPは約118MBになります。

```powershell
npm install                # 初回のみ
npm run electron           # 開発実行（ウィンドウが開きます）
npm run dist               # 配布用フォルダ＋ZIP＋SHA256をビルド
```

- 出力: `dist\sktdr-mouse-<commit>-win64\`（実行用フォルダ）、`.zip`（配布用）、`.zip.sha256`
  - `<commit>` はビルド元コミットの短縮SHA（例: `sktdr-mouse-4bad54c-win64.zip`）。未コミットの変更があるローカルビルドは `-dirty` 付きになります
- 展開して `sktdr-mouse.exe` をダブルクリックするだけで起動します（インストール不要）
- 起動時に内部サーバー（`http://localhost:3554`）を同一プロセスで立ち上げ、ネイティブウィンドウで表示します
- 2つ目の起動は既存ウィンドウにフォーカスします（単一インスタンス）
- ROCCAT用の設定キャッシュは `%APPDATA%\sktdr-mouse\data` に保存されます
- **同梱される `sktdr-mouse.exe` は公式 `electron.exe` とバイト単位で同一**（ファイル名のみ変更）。そのため Smart App Control 有効環境でもブロックされません（実機検証済み）
- ビルドは `electron-builder` を使わず `scripts/build-dist.js` が担当します。WindowsではローカルのElectronを再利用し、Linux/macOSでは公式の win32-x64 ZIPを自動ダウンロードして組み立てるため、**LinuxのCIランナーでもWindows版を生成できます**
- `node-hid` のネイティブモジュールは `resources/app.asar.unpacked` に展開され、N-APIビルドのためElectron向け再ビルドは不要です
- コード署名はしていないため、SmartScreenの警告が出る場合は「詳細情報」→「実行」を選択してください
- フォルダ内のEXEを個別に改変・再署名すると再びSACのブロック対象になります。更新時は**フォルダごと差し替え**てください
- ライセンス全文（本アプリ・Electron・Chromium・依存ライブラリ）と `licenses\THIRD_PARTY_NOTICES.txt` が自動的に同梱されます

### 自動リリース（Forgejo Actions）

`.forgejo/workflows/release.yml` が、最新ソースから配布版を作ってForgejoのReleaseへ自動添付します。

| トリガー | 動作 |
| --- | --- |
| `main` へpush | ビルドして **`latest` リリース**（タグ `latest`）のZIPを毎回差し替え |
| `v*` タグをpush | そのバージョンの **Release** を作成し、ZIPとSHA256を添付 |
| 手動実行 | main と同じ（リポジトリの Actions → Run workflow） |

- アセット名には**コミットID**が入ります
  - `latest`: `sktdr-mouse-<commit>-win64.zip`（例: `sktdr-mouse-4bad54c-win64.zip`）
  - バージョンタグ: `sktdr-mouse-<tag>-<commit>-win64.zip`（例: `sktdr-mouse-v1.1.0-4bad54c-win64.zip`）
  - 同じリリース内の旧アセットは自動削除されるため、コミットごとのZIPが溜まりません
- 認証はForgejo Actionsの**自動トークン**（`secrets.GITHUB_TOKEN`）を使用します。個人トークンの登録は不要です
- 実行には**ランナー**が必要です（リポジトリ設定 → Actions → Runners）。**ホストモード**のランナー（ラベル `linux`、Node.js 22・git・curl 導入済み）を想定しています。Dockerランナーを使う場合は `runs-on` を `docker` に戻し、`container: image: node:22-bookworm` を追加してください
- バージョン付きリリースを出すときは、先に `package.json` の `version` を更新してから `v1.1.0` のようにタグをpushします（不一致の場合はワークフローが失敗します）
- 手元から直接発行する場合:

  ```powershell
  $env:FORGEJO_TOKEN = "<write:repository権限のトークン>"
  npm run release -- --tag v1.1.0
  ```

- 添付ファイルの上限（Forgejoの `app.ini` の `[attachment] MAX_SIZE`）が118MBより小さい場合、アップロードは413で失敗します。管理者に上限を上げてもらうか、ZIPを外部ストレージに置いてReleaseからリンクしてください

## 設定できる項目

| 項目 | 内容 |
| --- | --- |
| DPI | 8ステージ × 50〜26000（50刻み）、ステージごとの色、ステージ数、現在のステージ |
| ポーリングレート | 125 / 250 / 500 / 1000 / 2000 / 4000 / 8000 Hz（接続方式の最大値で自動制限） |
| LOD | 0.7 / 1 / 2 mm |
| デバウンサ | 0〜30 ms |
| センサー | モーションシンク / アングルスナップ / リップルコントロール / 20Kモード / パフォーマンスモード / センサーモード(LP・HP) / スリープ時間 |
| ライト | 7種のモード、カラー、明るさ、速度、ON/OFF |
| プロファイル | 4プロファイルの切り替え |
| その他 | バッテリー表示（リアルタイム）、ファームウェア表示、ロングレンジモード、再ペアリング、工場リセット、**デバイスからの設定読み出し**（デバイス情報カードのボタン — Scyroxは本体フラッシュから全設定を再取得。ROCCATはプロトコル上読み戻し不可のためバッテリー照会による生存確認＋キャッシュ再同期） |

マウス本体のボタンでDPIやプロファイルを切り替えると、UIに自動反映されます（デバイスからの変更通知 `0x0A` を監視）。

## アーキテクチャ — 本体とマウス固有部分の分離

```
server.js                HTTP+SSEサーバー (localhost:3554) — マウス非依存・マルチデバイス
core/
  profile.js             devices/*.json のロード・検証
  manager.js             複数デバイスの管理、プロファイル⇔実機マッチング、ホットプラグ
  transport.js           HID送受信（キュー・再送・チェックサム）— 5形式: hid16 / swarmEcho64 / moji64 / hidpp / razer
  adapter.js             設定の読み書きエンジン＋シーケンス適用＋MOJI/HID++/Razerフレーム適用＋ホスト側キャッシュ
  codec.js               値のコーデック（byte/bool/enum/rgb/dpi/dpiXY/le16/dpiLeXY/stagesMask/bit/dpiBeXY4/oneBased…）
devices/
  compx-generic.json     Compx系汎用（Scyrox V8/V6・Lamzu Maya・VXE R1 Pro Max等を1ファイルでカバー）
  darmoshark-m5.json     Darmoshark M5（MOJIコマンドフレーム方式）
  logitech-pro-x-wireless.json  Logitech G PRO X Wireless（HID++ 2.0機能呼び出し方式）
  razer-deathadder-v3-pro.json  Razer DeathAdder V3 Pro（90バイトfeatureレポート方式）
  roccat-kone-pro-air.json  ROCCAT Kone Pro Air（Swarmシーケンス方式）
  vxe-mad-r-major.json   VXE MAD R Major（ページ方式フラッシュ）
data/
  <profileId>.json       Swarm方式機のホスト側設定キャッシュ（自動生成）
public/                  UI — プロファイルのスキーマから画面を自動生成・デバイス切替
scripts/
  build-dist.js         配布版（Electronフォルダ＋ZIP＋SHA256）のビルド
  publish-release.js    Forgejo Releaseの作成・アセット添付
  probe.js               Scyrox診断（読み取りのみ／--write-test）
  probe-roccat.js        Kone Pro Air診断（read-only）
  probe-darmoshark*.js   Darmoshark診断（1〜14: 探索→全コマンド検証の段階的記録）
  probe-superlight*.js   Logitech HID++診断（探索→DPI/レート書き込み検証）
  probe-razer*.js        Razer診断（featureレポート探索→レート/DPI/アイドル書き込み検証）
  probe-philips*.js      Philips Evnia診断（未解明プロトコルの探索記録）
  dump-hid-caps.ps1      HIDレポートディスクリプタ解析
  capture-roccat.ps1     USBPcapキャプチャ制御（RE用）
  analyze-roccat-session.js  pcap数値シグネチャ解析（RE用）
research/
  roccat-kone-pro-air.md ROCCAT解析の完全記録
  darmoshark-m5.md       Darmoshark解析の完全記録
  logitech-hidpp.md      Logitech HID++解析の完全記録
  philips-spk9418.md     Philips Evnia解析の記録（未解明・調査再開用メモ）
HANDOFF_PROMPT.md        他言語で再実装するための完全仕様（引継ぎ用プロンプト）
```

**プロトコルの詳細（パケット形式・コマンド表・フラッシュマップ・エンコード）と実装知見は
すべて `HANDOFF_PROMPT.md` に自己完結型で収録しています。**他のプログラミング言語への
移植はこのファイルを渡すだけで可能です。

## 新しいマウスを追加する

1. `devices/` に新しいプロファイルJSONを置く（形式は `scyrox-v8.json` と `HANDOFF_PROMPT.md` §11 を参照）
2. アプリを再起動するだけ。USB VID/PIDが一致する機器を挿すと自動認識されます

> 対応調査中の機種は `research/` に調査記録があります
> （例: ROCCAT Kone Pro Air — プロトコルが未解明のため、公式Swarmの
> USBキャプチャによるリバースエンジニアリングが必要な状態です）。

プロファイルJSONに記述するもの:

- USB識別子（VID/PID）、コレクション検出条件、プローブコマンド
- パケット形式（レポートID・レイアウト・チェックサム方式）
- コマンド表（ID・データ長・応答オフセット）
- 設定マップ（アドレス・コーデック・UI種別）
- UI文言（日本語ラベルなど）

特殊な値エンコードが必要な場合のみ `core/codec.js` にコーデックを追加します（既存の
`byte/bool/enum/rgb/rgbComplement/dpi` で大半の中国系8Kマウスはカバーできます）。

## コマンド

| コマンド | 説明 |
| --- | --- |
| `npm start` | 設定ツールを起動（ブラウザ版） |
| `npm run electron` | 設定ツールをElectronウィンドウで起動（開発用） |
| `npm run dist` | 配布用フォルダ＋ZIP＋SHA256をビルド |
| `npm run release -- --tag v1.0.0` | ビルドしてForgejoのReleaseへ添付（`FORGEJO_TOKEN` が必要） |
| `npm run probe` | デバイス検出・現在設定のダンプ（読み取りのみ） |
| `node scripts/probe.js --write-test` | 書き込みパスの検証（現在値を書き戻すだけの無害なテスト） |

## トラブルシューティング

- **「スリープ中」と表示される** … マウスを動かすかクリックしてスリープを解除してください。電源スイッチ・モード（2.4GHzドングル側）も確認してください。
- **「未接続」と表示される** … ドングルを差し直してください。2〜3秒で自動再接続します。
- **ポート 3554 が使用中** … `$env:PORT=3555; npm start`
- **公式ソフトと併用** … 同時に実行しないでください。

## 免責事項・注意事項

本ソフトは個人（sktdr）が開発した**非公式**ツールです。全文は **[DISCLAIMER.md](DISCLAIMER.md)** を参照してください。

- **非提携**: Razer / VXE / Compx / Scyrox / Lamzu / Logitech / ROCCAT / Darmoshark / ATK / Pulsar / Kysona 等の各社とは、提携・承認・後援・その他の関係を一切持ちません。各製品名・会社名は各社の商標または登録商標です
- **独立実装**: 通信プロトコルは、公開仕様・コミュニティによるリバースエンジニアリング・独自のUSBキャプチャ解析に基づく独立実装です。各社から提供・許諾されたものではありません
- **自己責任・無保証**: 設定の書き込みにより、設定の喪失、デバイスの誤動作、復旧不能（文鎮化）を含む損害が発生する可能性があります。作者およびコントリビュータは動作を保証せず、いかなる損害についても責任を負いません。MITライセンスの「AS IS」条項が適用されます
- **使用前の注意**:
  - 公式ソフトで現在の設定を控える（または本ソフトの「デバイスから設定を読み出す」でバックアップする）
  - 公式ソフトと同時に起動しない
  - ファームウェア更新は行わない（本ソフトはFW更新機能を提供しません）
  - 不安な場合は書き込みを行わず、**読み取りのみ**で使用する
  - 各国・地域の法令と各社の利用規約を確認し、遵守する

## ライセンス

- **本アプリ**: MIT（`LICENSE` を参照）
- **免責事項**: [DISCLAIMER.md](DISCLAIMER.md)（MITライセンスを変更するものではなく、追加の注意喚起です）
- **同梱コンポーネント**:
  - Electron 38 — MIT
  - Chromium / その他Electron同梱ライブラリ — `LICENSES.chromium.html` に全文収録
  - node-hid — MIT OR X11（同梱の hidapi は BSD-3-Clause）
  - pkg-prebuilds / node-addon-api — MIT
- `npm run dist` は、上記ライセンス全文と `licenses\THIRD_PARTY_NOTICES.txt` を**配布ZIPに自動同梱**します。この著作権表示・許諾文を削除しない限り、再配布・販売・改変はMITの条件内で自由です
- **Electronの名称・ロゴはElectronプロジェクトの商標**です。本アプリは非公式の独立プロジェクトであり、Electron / OpenJS Foundation / GitHub の承認や提携を示す形での配布・表示は行わないでください
- 同梱のElectronバイナリは公式配布物そのまま（MIT）で、ファイル名のみ変更しています
