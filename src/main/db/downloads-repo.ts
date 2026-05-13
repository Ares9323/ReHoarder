import type Database from 'better-sqlite3'

export type DownloadStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DownloadRow {
  id: string
  /** Source of the asset (`'fab'` / `'vault'` / `'legacy'`) — matches `assets.source`. */
  source: string
  /** ID of the asset within its source — matches `assets.source_id`. */
  sourceId: string
  title: string
  status: DownloadStatus
  bytesDone: number
  bytesTotal: number
  filesDone: number
  filesTotal: number
  /** Filename currently being assembled, when `status === 'running'`. */
  currentFile: string | null
  /** Absolute path of `<vault>/<assetSubdir>/`, set once the download starts. */
  destDir: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface DownloadRowDb {
  id: string
  source: string
  source_id: string
  title: string
  status: string
  bytes_done: number
  bytes_total: number
  files_done: number
  files_total: number
  current_file: string | null
  dest_dir: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

function fromDb(r: DownloadRowDb): DownloadRow {
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    title: r.title,
    status: r.status as DownloadStatus,
    bytesDone: r.bytes_done,
    bytesTotal: r.bytes_total,
    filesDone: r.files_done,
    filesTotal: r.files_total,
    currentFile: r.current_file,
    destDir: r.dest_dir,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }
}

export class DownloadsRepo {
  constructor(public readonly db: Database.Database) {}

  insert(row: Omit<DownloadRow, 'startedAt' | 'finishedAt' | 'error' | 'currentFile' | 'destDir'>): DownloadRow {
    this.db
      .prepare(
        `INSERT INTO downloads
           (id, source, source_id, title, status,
            bytes_done, bytes_total, files_done, files_total,
            current_file, dest_dir, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)`
      )
      .run(
        row.id,
        row.source,
        row.sourceId,
        row.title,
        row.status,
        row.bytesDone,
        row.bytesTotal,
        row.filesDone,
        row.filesTotal,
        row.createdAt
      )
    return this.findById(row.id)!
  }

  findById(id: string): DownloadRow | null {
    const r = this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as
      | DownloadRowDb
      | undefined
    return r ? fromDb(r) : null
  }

  listAll(): DownloadRow[] {
    const rows = this.db
      .prepare('SELECT * FROM downloads ORDER BY created_at DESC')
      .all() as DownloadRowDb[]
    return rows.map(fromDb)
  }

  nextQueued(): DownloadRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM downloads
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as DownloadRowDb | undefined
    return r ? fromDb(r) : null
  }

  setStatus(id: string, status: DownloadStatus, extras: Partial<DownloadRow> = {}): void {
    const sets: string[] = ['status = ?']
    const values: unknown[] = [status]
    for (const [k, v] of Object.entries(extras)) {
      const col = camelToSnake(k)
      sets.push(`${col} = ?`)
      values.push(v)
    }
    values.push(id)
    this.db.prepare(`UPDATE downloads SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  updateProgress(
    id: string,
    bytesDone: number,
    bytesTotal: number,
    filesDone: number,
    filesTotal: number,
    currentFile: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE downloads SET
           bytes_done = ?, bytes_total = ?, files_done = ?, files_total = ?, current_file = ?
         WHERE id = ?`
      )
      .run(bytesDone, bytesTotal, filesDone, filesTotal, currentFile, id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
  }

  removeCompleted(): number {
    const r = this.db
      .prepare(`DELETE FROM downloads WHERE status IN ('done', 'failed', 'cancelled')`)
      .run()
    return r.changes ?? 0
  }

  /**
   * Recover from an unclean shutdown by moving every `running` row back to
   * `queued`. Called at startup, before the manager picks up the next item.
   */
  resetInterrupted(): number {
    const r = this.db
      .prepare(
        `UPDATE downloads
            SET status = 'queued',
                started_at = NULL,
                current_file = NULL
          WHERE status = 'running'`
      )
      .run()
    return r.changes ?? 0
  }
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}
