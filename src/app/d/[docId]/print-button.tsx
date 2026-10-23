"use client";

/** Печать / сохранение в PDF (в окне печати браузера — «Сохранить как PDF»). */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="shrink-0 rounded-xl border border-[#e3e6ef] px-4 py-2 text-sm font-medium hover:bg-[#f6f7fb] print:hidden">
      🖨 PDF / печать
    </button>
  );
}
