export default function VoteCounts({ counts, name, runoffIds = [], title = '得票数' }: {
  counts: Record<string, number>;
  name: (id: string) => string;
  runoffIds?: readonly string[];
  title?: string;
}) {
  const rows = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const max = rows[0]?.[1] ?? 0;
  return <section className="vote-tally">
    <h3>{title}</h3>
    <ul>{rows.map(([id, votes]) => {
      const leading = max > 0 && votes === max;
      const candidate = runoffIds.includes(id);
      return <li className={leading || candidate ? 'vote-tally-highlight' : undefined} key={id}>
        <div className="vote-tally-row">
          <span>{name(id)}{(leading || candidate) && <small>{candidate ? '決選候補' : '最多票'}</small>}</span>
          <strong>{votes}票</strong>
        </div>
        <div className="vote-tally-track" aria-hidden="true">
          <div className="vote-tally-bar" style={{ width: `${max ? votes / max * 100 : 0}%` }} />
        </div>
      </li>;
    })}</ul>
  </section>;
}
