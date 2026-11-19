# 東京店の自動修復

Cloud Scheduler が15分おきに `haraka-tokyo-repair` を起動します。東京店の最新オーダーで同期・生成の失敗を検出したときに Codex を呼びます。通常の生成と一時障害の再試行は既存のジョブと watchdog が担当します。

画像生成が完了し、Google Sheets への反映だけが失敗した場合は、同じ実行の保存済みデータを Sheets に再送します。この経路では Codex の呼び出しと買取表画像の再生成を省きます。

Codex に渡すのは公開リポジトリの対象コード、エラー分類、コード上の位置、件数です。元の入力は非公開バケットで検証します。修正は許可された関数の最大2ファイル・5置換、変更前後合計120行までです。修正前に同じ失敗を再現し、修正後の価格・商品・版・画像・ページ構成、ジョブの型とテストを検証します。

コントローラーが検証済みのコード差分に署名し、GitHub Actions が署名、親コミット、ツリーを確認して実行中だけ有効な権限で反映します。東京店の該当ジョブを検証済みイメージに切り替え、同じオーダーを再実行し、店頭と郵送の生成結果および Peleka の反映世代まで読み戻します。再生成の検証が失敗した場合は、並行更新を確認したうえでジョブのイメージとソースを戻します。出力データの状態は再生成の読み戻しで判断します。

## 運用

- モデルの認証には GCP Secret Manager の `haraka-tokyo-repair-openai-api-key` を使用します。有効なバージョンを登録すると次の監視から利用できます。
- Cloud Run の実行ログで `healthy`、`repaired`、`waiting_for_model_key`、`needs_review` などを確認できます。再現できない障害、採用版の根拠が不足する場合、許可範囲外の修正は `needs_review` に記録します。
- 監視を一時停止するには、東京リージョンの Scheduler `haraka-tokyo-repair-15min` を停止します。進行中の修復は Cloud Run の実行一覧で確認できます。状態と直前のイメージは非公開 state バケットの `controller/tokyo.json` に記録されます。
- 初回リリースでは `bootstrap.yaml` でコミット固有の2イメージをビルドし、東京店の sync・generate に `TOKYO_REPAIR_SOURCE_REVISION` と `TOKYO_REPAIR_FIXTURE_BUCKET` を指定します。`provision.ps1 -Apply -DeployController -ControllerImage <digest> -EnableSchedule -Readback` で監視を反映します。
