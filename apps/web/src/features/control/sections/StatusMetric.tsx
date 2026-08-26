export function formatHours(seconds: number) {
  if (seconds <= 0) return "0 hr";
  const hours = seconds / 3600;
  return `${hours >= 100 ? Math.round(hours).toLocaleString() : hours.toFixed(hours >= 10 ? 1 : 2)} hr`;
}
