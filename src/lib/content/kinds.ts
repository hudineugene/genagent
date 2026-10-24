/** Виды текстов и площадки контент-студии (общие для базы и интерфейса — без серверного кода). */
export const CONTENT_KINDS = ["post", "article", "ad", "seo", "vacancy", "repurpose"] as const;
/** Сколько вариантов можно попросить за раз: реклама — до 10 (A/B-тесты), остальное — до 3 */
export const maxVariants = (kind: string) => (kind === "ad" ? 10 : 3);
export const CONTENT_PLATFORMS = ["telegram", "instagram", "facebook", "linkedin", "threads", "site", "email"] as const;
