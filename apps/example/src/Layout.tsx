export interface LayoutProps {
  title: string
  children: any
}

export function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="/styles/counter.css" />
        <script src="/script/index.ts" defer></script>
      </head>
      <body>{children}</body>
    </html>
  )
}

export interface HeroHeaderProps {
  emoji: string
  title: string
  subtitle: any
}

export function HeroHeader({ emoji, title, subtitle }: HeroHeaderProps) {
  return (
    <header class="hero">
      <div class="logo-wrapper">
        <span class="logo-emoji">{emoji}</span>
      </div>
      <h1 class="gradient-text">{title}</h1>
      <p class="subtitle">{subtitle}</p>
    </header>
  )
}

export interface CardHeaderProps {
  icon: string
  title: string
}

export function CardHeader({ icon, title }: CardHeaderProps) {
  return (
    <div class="card-header">
      <span class="card-icon">{icon}</span>
      <h2>{title}</h2>
    </div>
  )
}

export default function Redirect() {
  return <meta http-equiv="refresh" content="0; url=/" />
}
