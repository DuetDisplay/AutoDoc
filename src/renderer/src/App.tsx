import { HashRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'
import { Upcoming } from './pages/Upcoming'
import { Recordings } from './pages/Recordings'
import { MeetingDetail } from './pages/MeetingDetail'
import { Search } from './pages/Search'
import { AskAI } from './pages/AskAI'
import { Settings } from './pages/Settings'
import { ROUTES } from '../../shared/constants'

export default function App() {
  return (
    <HashRouter>
      <div className="flex h-screen bg-bg-primary">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path={ROUTES.upcoming} element={<Upcoming />} />
            <Route path={ROUTES.recordings} element={<Recordings />} />
            <Route path={ROUTES.meetingDetail} element={<MeetingDetail />} />
            <Route path={ROUTES.search} element={<Search />} />
            <Route path={ROUTES.askAi} element={<AskAI />} />
            <Route path={ROUTES.settings} element={<Settings />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  )
}
