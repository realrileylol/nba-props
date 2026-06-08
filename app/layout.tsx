export const metadata = {
  title: 'NBA Broadcaster Prop Tracker',
  description: 'Real-time settlement data synced from live broadcast tracking.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
