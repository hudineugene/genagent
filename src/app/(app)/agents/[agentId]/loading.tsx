import { Skeleton } from "@/components/ui";

/** Загрузка вкладки агента (шапка агента уже на месте): силуэт настроек и тест-чата. */
export default function Loading() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]" aria-busy="true">
      <div className="space-y-4">
        <Skeleton className="h-11 rounded-2xl" />
        <Skeleton className="h-10 w-2/3 rounded-xl" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <Skeleton className="hidden h-[32rem] rounded-2xl lg:block" />
    </div>
  );
}
