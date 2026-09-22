# 東京満満のカード画像取得

TCGMP の自動取得・商用画像利用について許可取得済みという利用者の確認を前提とします。
価格はシンソク郵送買取のままです。東京のPSA・BOX画像だけを対象とし、他店舗は変更しません。

リポジトリのルートで実行します。取得は単一 CLI プロセス、各応答後 8 秒以上です。
ECONNRESET のみ失敗を記録して次商品へ進み、それ以外のエラーでは停止します。

```powershell
npx.cmd tsx packages/job/src/scripts/scrape-tcgmp.ts targets.json output/tcgmp/candidates
```

`targets.json` は次の配列です。`query` は任意の検索語上書きです。価格フィールドは利用しません。

```json
[{"id":"IAO2600001197","franchise":"ONE PIECE","name":"レベッカ","model_number":"OP05-091"}]
```

候補・元ページ・版別 SKU・画像・SHA256 をローカル保存します。先頭検索ページのみであり、
候補１件でも唯一の版である保証はありません。カード番号だけでは確定せず、元の商品画像と絵柄・
レアリティ・プロモ仕様を確認し、SAMPLE 表記・PSA ケースがない画像だけ採用してください。
完了済み候補レポートは再取得しません。強制終了後の `.tcgmp-crawl.lock` はプロセス停止を確認してから除去します。

確認した画像と同じディレクトリに `reviewed.json` を作成します。

```json
[{
  "source_shinsoku_id":"対象のシンソクID", "franchise":"ONE PIECE",
  "name":"元商品名そのまま", "model_number":"元カード番号そのまま",
  "tcgmp_product_id":"確認済みの数字ID", "tcgmp_sku":"確認済み版別SKU",
  "sha256":"画像の64桁SHA256", "file":"同じSHA256.jpg",
  "verified_at":"2026-09-07T00:00:00Z",
  "evidence":{"no_sample":true,"no_slab":true,"variant_confirmed":true,"note":"元商品との絵柄・版の照合根拠"}
}]
```

```powershell
npx.cmd tsx packages/job/src/scripts/import-tcgmp-images.ts output/tcgmp/candidates/reviewed.json
```

上記はローカル検証のみです。画像の見た目を自動判定するものではありません。
本番反映承認後に migration `20260907000004`、画像・対応表登録、東京 Job リリースを行います。
登録時のみ既存の `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` と
`STORE_NAME=manman-akihabara` を使用し、上の登録コマンド末尾に `--apply` を追加します。
登録は同じ画像ハッシュで再実行可能です。失敗時は既存対応表を読み返してから再試行してください。

通常 resync → generate で新しい対応を prepared_card に固定し、通常ギャラリーへ出力します。
既存生成済みページは自動更新しません。未対応 PSA は商品と価格を維持し画像を null とし、
ケース画像へのフォールバックは行いません（既存描画の裏面表示）。
**未対応件数を確認せずに本番切替しないでください。** 対応表未適用の Job だけを先行リリースすると同期が失敗します。

## 利用者による画像照合

取得済み候補を、元画像と並べた単独 HTML にできます。元画像 URL を含む targets 配列を指定します。

```powershell
npm.cmd -w packages/job run build
node packages/job/dist/scripts/build-tcgmp-review.js output/tcgmp/review-targets.json output/tcgmp output/tcgmp/review/index.html
```

HTML をブラウザーで開き、候補選択後に「絵柄・版が一致」「SAMPLE 表記なし」「PSA ケースなし」の
３項目を確認して採用します。「該当なし」「保留」も記録できます。未取得は不一致とは区別されます。
候補画像は HTML 内に埋め込み、TCGMP への自動通信は行いません。未保存の元画像はシンソクから表示します。

「判定JSONを書き出す」で保存して返送してください。採用分は `reviewed`、全判定は `decisions` に含まれます。
同じ HTML へ読み込むと作業を再開できます。自動保存はブラウザー依存なので JSON でも保存してください。
候補内容が変わると別データセットとして扱い、以前の判定を勝手に引き継ぎません。
生成先には採用画像ファイルもコピーされます。返送された JSON を同じディレクトリに保存すれば
既存 `import-tcgmp-images` のローカル検証に使用できます。本番登録は別途 `--apply` が必要です。

### Haraka DB を優先

`build-tcgmp-review` の４つ目の引数に `{ "cards": [...] }` 形式の既存DB読取結果を渡すと、
東京 `db_card` の画像を先に照合します。通常syncも同じ `findHarakaImage` を使います。
価格はシンソクのままです。現在は同期済み `db_card` の参照で、Sheetsの再同期は行いません。

```powershell
node packages/job/dist/scripts/build-tcgmp-review.js output/tcgmp/review-targets.json output/tcgmp output/tcgmp/review/index.html output/tcgmp/haraka-db-images.json
```

自動照合できたDB画像は「DB利用」へ、番号欠落・曖昧な既存画像は人間確認へ分けます。
`missing-image-targets.json` はDBに使える候補がない商品だけです。
そのうち外部候補も未取得のものを `fetch-image-targets.json` に出力するので、これを取得CLIへ渡してください。
番号検索でゼロ件でも、サイトに未収録とは断定できません。取得レポートの検索語・エラーを確認してください。

手動で選んだDB画像は判定JSONの `haraka_reviewed` に保存されます。
これはTCGMP画像登録用CLIの対象外です。混在JSONを渡すと一部だけ登録せず全体を拒否します。
利用者から返されたDB選択は、登録先・商品対応を別途確認してから反映してください。
