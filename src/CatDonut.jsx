import { PieChart, Pie, Cell } from "recharts";

// Category-spend donut, extracted from App.jsx so recharts (the single heaviest
// dependency) code-splits into its own lazy chunk instead of the main bundle.
export default function CatDonut({ rows, selCid, toggleCat }) {
  return (
    <PieChart width={208} height={208}>
      <Pie data={rows.map(r => ({ name: r.cat.name, value: r.amt }))} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={64} outerRadius={96} paddingAngle={rows.length > 1 ? 2 : 0} cornerRadius={3} stroke="none" isAnimationActive={false} onClick={(_, idx) => { const r = rows[idx]; if (r) toggleCat(r.cid); }}>
        {rows.map(r => <Cell key={r.cid} fill={r.cat.color} fillOpacity={selCid && r.cid !== selCid ? 0.3 : 1} style={{ cursor: "pointer", outline: "none" }} />)}
      </Pie>
    </PieChart>
  );
}
