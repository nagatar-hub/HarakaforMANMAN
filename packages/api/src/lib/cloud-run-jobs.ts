import { JobsClient } from '@google-cloud/run';

const DEFAULT_PROJECT = 'spectre-tomstocks-20260227';
const DEFAULT_LOCATION = 'asia-northeast1';

let cachedClient: JobsClient | null = null;

function getClient(): JobsClient {
  if (!cachedClient) cachedClient = new JobsClient();
  return cachedClient;
}

export interface ExecuteJobOptions {
  env?: Record<string, string>;
}

export interface ExecuteJobResult {
  operationName: string;
  executionName: string | null;
}

export async function executeCloudRunJob(
  jobName: string,
  options: ExecuteJobOptions = {},
): Promise<ExecuteJobResult> {
  const client = getClient();
  const project = process.env.GCP_PROJECT_ID || DEFAULT_PROJECT;
  const location = process.env.GCP_LOCATION || DEFAULT_LOCATION;
  const name = `projects/${project}/locations/${location}/jobs/${jobName}`;

  const envOverrides = Object.entries(options.env ?? {}).map(([name, value]) => ({
    name,
    value,
  }));

  const [operation] = await client.runJob({
    name,
    overrides: envOverrides.length > 0
      ? { containerOverrides: [{ env: envOverrides }] }
      : undefined,
  });

  return {
    operationName: operation.name ?? 'unknown',
    executionName: operation.metadata?.name ?? null,
  };
}
