import type { MetadataRoute } from "next";
import icon192 from "@/assets/brand/app-192.png";
import icon512 from "@/assets/brand/app-512.png";
import maskable from "@/assets/brand/app-maskable.png";

/**
 * Установка программы как приложения (компьютер и телефон): значок GenAgent, отдельное окно без адресной строки.
 * Значки — из /_next/static, открыты без входа.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GenAgent — студия ИИ-агентов",
    short_name: "GenAgent",
    description: "Конструктор ИИ-агентов для клиентов студии",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f5f7",
    theme_color: "#14161a",
    lang: "ru",
    icons: [
      { src: icon192.src, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon512.src, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: maskable.src, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Диалоги", url: "/inbox" },
      { name: "Клиенты", url: "/clients" },
      { name: "Аналитика", url: "/analytics" },
    ],
  };
}
