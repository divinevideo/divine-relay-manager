// ABOUTME: Shared admin navigation bar linking all *.admin.divine.video tools
export default function AdminBar() {
  const linkStyle = "text-gray-400 hover:text-white text-xs px-2 py-1 rounded transition-colors"
  const currentStyle = "text-blue-400 bg-blue-900/30 text-xs px-2 py-1 rounded"

  return (
    <div className="bg-gray-900 border-b border-gray-800 px-4 flex items-center h-9 gap-1 text-xs overflow-x-auto whitespace-nowrap">
      <a href="https://admin.divine.video" className={linkStyle} title="Dashboard">◆ Admin</a>
      <span className="text-gray-700">|</span>
      <a href="https://moderation.admin.divine.video/admin" className={linkStyle} title="Video Moderation">Moderation</a>
      <a href="https://review.admin.divine.video/admin" className={linkStyle} title="Automatic Labels">Review</a>
      <a href="https://faro.admin.divine.video" className={linkStyle} title="Content Reports">Reports</a>
      <a href="https://realness.admin.divine.video" className={linkStyle} title="AI Detection">Realness</a>
      <a href="https://names.admin.divine.video" className={linkStyle} title="Name Server">Names</a>
      <a href="/" className={currentStyle} title="Relay Manager">Relay</a>
      <a href="https://discovery.admin.divine.video" className={linkStyle} title="Vine Discovery">Discovery</a>
      <span className="text-gray-700">|</span>
      <a href="https://rabblelabs.zendesk.com/" className={linkStyle} title="Support">Zendesk</a>
    </div>
  )
}
