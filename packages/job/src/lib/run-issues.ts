import { COLOR, sendDiscordNotification } from './discord.js';

export type IssueOwner = 'データ修正' | 'エンジニア対応';
export type ReportIssue = (owner: IssueOwner, subject: string, reason: string) => void;

export function exclude(report: ReportIssue | undefined, owner: IssueOwner, subject: string, reason: string): never[] {
  if (!report) throw new Error(reason);
  report(owner, subject, reason);
  return [];
}

/** Collected only for this job invocation. The full list stays in the run log. */
export class RunIssues {
  private readonly groups = new Map<IssueOwner, Set<string>>();

  constructor(private readonly scope: string) {}

  readonly report: ReportIssue = (owner, subject, reason) => {
    const line = [subject, reason].join(' — ').replace(/\s+/g, ' ').trim();
    const lines = this.groups.get(owner) ?? new Set<string>();
    if (lines.has(line)) return;
    lines.add(line);
    this.groups.set(owner, lines);
    console.warn(this.scope, owner, line);
  };

  async notify() {
    for (const [owner, lines] of this.groups) {
      const examples = [...lines].slice(0, 14).map(line => line.slice(0, 200));
      if (lines.size > examples.length) examples.push('残り ' + (lines.size - examples.length) + ' 件は実行ログに記録しました。');
      await sendDiscordNotification({
        title: '【' + owner + '】今回の除外・部分失敗（' + lines.size + '件）',
        description: [this.scope, ...examples].join('\n'),
        color: COLOR.WARNING,
      });
    }
  }
}
