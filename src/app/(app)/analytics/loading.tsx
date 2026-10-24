import { Skeleton } from "@/components/ui";

/** Загрузка аналитики: силуэт переключателя периода, плиток и двух графиков. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6" aria-busy="true">
      <Skeleton className="h-8 w-40" />
      <div className="flex justify-between">
        <Skeleton className="h-9 w-56 rounded-xl" />
        <Skeleton className="h-9 w-48 rounded-xl" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}
