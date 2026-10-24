import type { Metadata } from "next";
import { Inter, Montserrat } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter" });
// Заголовки — плотный геометрический шрифт в духе надписи GenAgent на логотипе
const montserrat = Montserrat({ subsets: ["latin", "cyrillic"], weight: ["600", "700", "800"], variable: "--font-montserrat" });

// Тема до первой отрисовки (без мигания): выбор из localStorage («light» / «dark»), иначе — как в системе.
// Переключатель в меню меняет localStorage и data-theme; системную смену ловим здесь же.
const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=matchMedia('(prefers-color-scheme: dark)');function a(){var t=localStorage.getItem('theme');d.dataset.theme=t==='light'||t==='dark'?t:(m.matches?'dark':'light')}a();m.addEventListener('change',a);window.__applyTheme=a}catch(e){}})()`;

export const metadata: Metadata = {
  title: "GenAgent — студия ИИ-агентов",
  description: "Конструктор ИИ-агентов для клиентов студии",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={`${inter.variable} ${montserrat.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
