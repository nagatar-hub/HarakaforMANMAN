/**
 * Cloud Run Jobs API の薄いラッパー。
 * watchdog からのリトライで haraka-generate を再実行するために使う。
 *
 * 認証は呼び出し側で渡す tokenFetcher（メタデータサーバーや
 * google-auth-library で取得した access token）に委譲する。
 */

export type EnvVar = { name: string; value: string };
export type ContainerOverride = { env: EnvVar[] };

/**
 * Cloud Run Jobs Admin API v2 の `:run` リクエスト入力。
 *
 * 注意: `containerOverrides[]` は **タスク別ではなくコンテナ別** の override。
 * 1 task spec に複数コンテナが定義されているケースを除き、配列長は通常 1。
 * 全 task に同じ env が broadcast される（task ごとに異なる env を流したい場合は
 * `CLOUD_RUN_TASK_INDEX` で分岐するか、kind ごとに別 :run を打つ必要がある）。
 */
export type RunCloudRunJobInput = {
  jobName: string;
  taskCount: number;
  containerOverrides: ContainerOverride[];
  tokenFetcher: () => Promise<string>;
  projectId?: string;
  region?: string;
};

export async function runCloudRunJob(input: RunCloudRunJobInput): Promise<void> {
  const projectId = input.projectId ?? process.env.GCP_PROJECT_ID;
  const region = input.region ?? process.env.GCP_REGION ?? 'asia-northeast1';
  if (!projectId) throw new Error('GCP_PROJECT_ID が未設定です');

  const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${input.jobName}:run`;
  const token = await input.tokenFetcher();

  const body = {
    overrides: {
      taskCount: input.taskCount,
      containerOverrides: input.containerOverrides,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloud Run Jobs API ${res.status}: ${text.substring(0, 500)}`);
  }
}

/**
 * Cloud Run のメタデータサーバーから OAuth2 access_token を取得する。
 * Cloud Run / GCE / GKE 環境内でのみ動作する。
 *
 * Cloud Run Admin API v2 (`run.googleapis.com/v2/.../jobs:run`) は
 * ID トークンではなく access_token を要求するため `/identity` ではなく `/token` を使う。
 */
export async function fetchMetadataAccessToken(): Promise<string> {
  const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`metadata access token fetch: ${res.status} ${text.substring(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number; token_type: string };
  return json.access_token;
}
