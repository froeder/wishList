import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand-block">
          <span className="brand-mark">W</span>
          <div>
            <strong>WishList</strong>
            <span>{user?.email}</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Navegação principal">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/add">Adicionar</NavLink>
        </nav>

        <button className="button button-ghost" type="button" onClick={handleLogout}>
          Sair
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
