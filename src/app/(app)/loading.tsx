import { Spinner } from "@/components/ui";

export default function Loading() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-muted">
      <Spinner className="size-6" />
    </div>
  );
}
