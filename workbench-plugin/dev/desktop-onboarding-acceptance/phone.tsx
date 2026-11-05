/** Production phone compatibility component; no call/voice/session adapters are mounted. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OnboardingCall } from '../../../butler-app/src/onboarding/OnboardingCall'
import '../../../butler-app/src/styles.css'
function App() {
  const [open, setOpen] = useState(true)
  return open ? <OnboardingCall onClose={() => setOpen(false)} /> : <p>已回主页</p>
}
createRoot(document.getElementById('app')!).render(<App />)
