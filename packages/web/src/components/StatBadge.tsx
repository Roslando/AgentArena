export function StatBadge({
  icon,
  label,
  value,
  warn,
}: {
  icon: string;
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
        warn ? "border-amber-500/40 bg-amber-500/10" : "border-slate-700/60 bg-slate-900/40"
      }`}
    >
      <span className="flex items-center gap-2 text-xs text-slate-400">
        <span>{icon}</span>
        {label}
      </span>
      <span className={`text-sm font-semibold ${warn ? "text-amber-300" : "text-slate-100"}`}>
        {value}
      </span>
    </div>
  );
}
