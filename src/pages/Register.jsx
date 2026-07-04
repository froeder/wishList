import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { register } = useAuth();

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    try {
      await register(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Erro ao criar conta.');
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Criar conta</h1>
        <p>Cadastre-se para salvar seus desejos.</p>
        <input type="email" placeholder="E-mail" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <input type="password" placeholder="Senha" value={password} onChange={(event) => setPassword(event.target.value)} required />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit">Registrar</button>
        <Link to="/login">Já tenho conta</Link>
      </form>
    </div>
  );
}
