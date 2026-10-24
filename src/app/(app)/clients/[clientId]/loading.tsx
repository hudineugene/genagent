import { Skeleton } from "@/components/ui";

/** Загрузка страницы клиента: силуэт шапки с цифрами, меню разделов и карточек. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6" aria-busy="true">
      <div className="rounded-2xl border border-border">
        <div className="flex items-center gap-4 p-5 pt-6">
          <Skeleton className="size-14 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-3.5 w-72" />
          </div>
          <Skeleton className="hidden h-9 w-40 rounded-xl sm:block" />
        </div>
        <div className="grid grid-cols-2 border-t border-border sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5 px-5 py-3">
              <Skeleton className="h-6 w-12" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
