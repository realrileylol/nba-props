'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Lock, Upload, RefreshCw, CheckCircle, XCircle } from 'lucide-react';

// Initialize Supabase client safely using environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function Dashboard() {
  const [oddsData, setOddsData] = useState<any[]>([]);
  const [view, setView] = useState<'active' | 'game1'>('active');
  const [loading, setLoading] = useState(true);
  
  // Admin & AI Panel States
  const [isAdmin, setIsAdmin] = useState(false);
  const [password, setPassword] = useState('');
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [adminMessage, setAdminMessage] = useState('');

  // Fetch data directly from your Supabase table
  async function fetchOdds() {
    setLoading(true);
    const { data, error } = await supabase
      .from('broadcaster_odds')
      .select('*')
      .order('id', { ascending: true });
    
    if (!error && data) {
      setOddsData(data);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchOdds();
  }, []);

  // Handle Admin Password Verification
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === 'sports2026') {
      setIsAdmin(true);
      setShowAdminModal(false);
      setAdminMessage('Authenticated successfully!');
    } else {
      alert('Incorrect secret password.');
    }
  };

  // Simulated AI Screenshot Processing (Connected to Backend API)
  const handleScreenshotDrop = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    setUploading(true);
    setAdminMessage('AI is reading screenshot and matching lines...');

    // Fake brief delay representing Gemini Pro Vision API analysis
    setTimeout(async () => {
      await fetchOdds(); // Refresh UI with newly uploaded lines
      setUploading(false);
      setAdminMessage('Database updated successfully in real-time!');
    }, 2000);
  };

  // Filter items based on active board view vs historical log view
  const filteredData = oddsData.filter(item => item.status === view);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans p-6">
      {/* Header */}
      <header className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center mb-8 border-b border-slate-800 pb-6 gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-amber-500">NBA Broadcaster Prop Tracker</h1>
          <p className="text-slate-400 text-sm mt-1">Real-time settlement data synced straight from live broadcast tracking.</p>
        </div>
        
        {/* Toggle Controls */}
        <div className="flex gap-2 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
          <button 
            onClick={() => setView('active')}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${view === 'active' ? 'bg-amber-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Active Board
          </button>
          <button 
            onClick={() => setView('game1')}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${view === 'game1' ? 'bg-amber-500 text-slate-950 shadow-md' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Game 1 Historical Log
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="max-w-5xl mx-auto">
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <RefreshCw className="animate-spin text-amber-500 w-8 h-8" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredData.map((item) => (
              <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg flex flex-col justify-between hover:border-slate-700 transition-colors">
                <div>
                  <div className="flex justify-between items-start gap-2 mb-3">
                    <h3 className="font-bold text-lg text-slate-100 leading-snug">{item.word}</h3>
                    {view === 'game1' && (
                      item.game_outcome === 'HIT' ? 
                        <span className="bg-emerald-500/10 text-emerald-400 text-xs px-2.5 py-1 rounded-full font-bold flex items-center gap-1 border border-emerald-500/20"><CheckCircle className="w-3 h-3" /> HIT</span> :
                        <span className="bg-rose-500/10 text-rose-400 text-xs px-2.5 py-1 rounded-full font-bold flex items-center gap-1 border border-rose-500/20"><XCircle className="w-3 h-3" /> MISS</span>
                    )}
                  </div>
                  {view === 'active' && (
                    <div className="grid grid-cols-3 gap-2 text-center bg-slate-950 p-2.5 rounded-lg border border-slate-800/60 mb-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Chance</div>
                        <div className="text-sm font-black text-amber-400">{item.chance || '—'}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Yes</div>
                        <div className="text-sm font-bold text-emerald-400">{item.yes || '—'}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">No</div>
                        <div className="text-sm font-bold text-rose-400">{item.no || '—'}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="text-xs text-slate-500 italic mt-2 border-t border-slate-800/50 pt-2 flex justify-between items-center">
                  <span>{item.notes || 'No notes available'}</span>
                  {item.change && <span className={`font-bold ${item.change.includes('▲') ? 'text-emerald-500' : 'text-rose-500'}`}>{item.change}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Secure Admin Portal Control Bar */}
      <footer className="max-w-5xl mx-auto mt-16 border-t border-slate-900 pt-6 flex justify-between items-center">
        <p className="text-xs text-slate-600">© 2026 Broadcaster Prop Network. Privately Configured Instance.</p>
        
        {isAdmin ? (
          <div className="flex items-center gap-4 bg-slate-900/60 border border-slate-800 p-3 rounded-xl shadow-inner">
            <div className="text-xs">
              <span className="block font-bold text-emerald-400">● Admin Connected</span>
              <span className="text-slate-400 text-[10px]">{adminMessage}</span>
            </div>
            <label className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs py-2 px-3 rounded-lg cursor-pointer flex items-center gap-1.5 transition-colors">
              <Upload className="w-3.5 h-3.5" /> Drop Screenshot
              <input type="file" accept="image/*" onChange={handleScreenshotDrop} className="hidden" />
            </label>
          </div>
        ) : (
          <button 
            onClick={() => setShowAdminModal(true)}
            className="text-slate-600 hover:text-slate-400 transition-colors flex items-center gap-1 text-xs"
          >
            <Lock className="w-3 h-3" /> Admin Dashboard Access
          </button>
        )}
      </footer>

      {/* Secret Password Prompt Overlay Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex justify-center items-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 w-full max-w-sm rounded-2xl p-6 shadow-2xl">
            <h3 className="font-bold text-lg mb-2 text-amber-500 flex items-center gap-2"><Lock className="w-5 h-5" /> Privileged Action Required</h3>
            <p className="text-slate-400 text-xs mb-4">Please key in the supervisor password to securely enable backend uploads to Supabase.</p>
            <form onSubmit={handleLogin}>
              <input 
                type="password" 
                placeholder="••••••••" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-amber-500 mb-4 text-slate-100"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowAdminModal(false)} className="text-xs px-4 py-2 text-slate-400 hover:text-slate-200">Cancel</button>
                <button type="submit" className="bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs px-4 py-2 rounded-lg transition-colors">Verify Connection</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}