import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Erro ao entrar.');
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Entrar</h1>
        <p>Use sua conta do Firebase para continuar.</p>
        <input type="email" placeholder="E-mail" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <input type="password" placeholder="Senha" value={password} onChange={(event) => setPassword(event.target.value)} required />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Entrar</button>
        <Link to="/register">Criar conta</Link>
      </form>
    </div>
  );
}
