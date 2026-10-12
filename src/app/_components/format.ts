const TIME_ZONE = "Europe/Paris";

export function formatSlotDate(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatAgo(date: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `il y a ${hours} h ${String(minutes % 60).padStart(2, "0")}`;
}
