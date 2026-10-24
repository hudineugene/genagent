import { readContentImage } from "@/lib/content/images";

/** Картинка поста контент-студии — без входа (её забирают Threads и соцсети); имя неугадываемое. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const img = readContentImage((await params).name);
  if (!img) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(img.buf), {
    headers: { "content-type": img.type, "cache-control": "public, max-age=31536000, immutable", "x-robots-tag": "noindex" },
  });
}
