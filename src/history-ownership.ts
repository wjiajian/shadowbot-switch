import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// The installer also runs this standalone file with the previous release's Node
// before changing its launcher or manifest. Keep it independent of compiled modules.
export function verifyHistoryOwnership(database: string, adapterPath: string) {
  const db = new DatabaseSync(database, { readOnly: true, timeout: 3000 });
  try {
    db.exec('PRAGMA query_only=ON');
    let mismatch;
    if (!existsSync(adapterPath)) {
      mismatch = db.prepare('SELECT 1 FROM main.session LIMIT 1').get();
    } else {
      db.prepare('ATTACH DATABASE ? AS adapter').run(pathToFileURL(adapterPath).href + '?mode=ro');
      const hasMetadata = db.prepare('PRAGMA main.table_info(session)').all().some(column => column.name === 'metadata');
      const checkMarker = hasMetadata ? `OR json_extract(s.metadata, '$.shadowbotContextCompatibility')
        IS NOT json_extract(a.session, '$.metadata.shadowbotContextCompatibility')` : '';
      mismatch = db.prepare(`SELECT 1 FROM main.session s FULL OUTER JOIN adapter.session a ON a.id=s.id
        WHERE s.id IS NULL OR a.id IS NULL OR s.time_updated != json_extract(a.session,'$.time.updated')
        OR s.title != json_extract(a.session,'$.title') ${checkMarker} LIMIT 1`).get();
    }
    if (mismatch) throw new Error('活动会话库与所选后端的历史不一致。请退出影刀，备份活动库（含 WAL）、当前会话指针与 .shadowbot-switch，再从匹配的备份恢复或分离升级期间产生的会话。');
  } finally { db.close(); }
}

if (import.meta.main) {
  try { verifyHistoryOwnership(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error instanceof Error ? error.message : '会话归属检查失败。'); process.exitCode = 1; }
}
