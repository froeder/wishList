import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { listGroups, listItems } from '../services/firestore';
import { formatCurrency, parsePriceValue } from '../utils/price';

export default function DashboardPage() {
  const { user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadDashboard = async () => {
    if (!user?.uid) {
      return;
    }

    setLoading(true);
    const [fetchedGroups, fetchedItems] = await Promise.all([
      listGroups(user.uid),
      listItems(user.uid),
    ]);
    setGroups(fetchedGroups);
    setItems(fetchedItems);
    setLoading(false);
  };

  useEffect(() => {
    loadDashboard();
  }, [user?.uid]);

  const groupNameById = useMemo(() => {
    return groups.reduce((acc, group) => {
      acc[group.id] = group.name;
      return acc;
    }, {});
  }, [groups]);

  const totalAmount = useMemo(() => {
    return items.reduce((sum, item) => sum + parsePriceValue(item.price), 0);
  }, [items]);

  const groupedItems = items.filter((item) => item.groupId).length;
  const ungroupedItems = items.length - groupedItems;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Resumo</p>
          <h1>Dashboard</h1>
        </div>
        <Link className="button button-primary" to="/add">
          Adicionar link
        </Link>
      </div>

      <section className="metric-grid" aria-label="Indicadores da lista">
        <article className="metric-card metric-card-total">
          <span>Total estimado</span>
          <strong>{formatCurrency(totalAmount)}</strong>
        </article>
        <article className="metric-card">
          <span>Itens</span>
          <strong>{items.length}</strong>
        </article>
        <article className="metric-card">
          <span>Grupos</span>
          <strong>{groups.length}</strong>
        </article>
        <article className="metric-card">
          <span>Sem grupo</span>
          <strong>{ungroupedItems}</strong>
        </article>
      </section>

      <section className="list-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Lista de compras</p>
            <h2>Itens monitorados</h2>
          </div>
          {groupedItems > 0 ? <span className="counter">{groupedItems} agrupados</span> : null}
        </div>

        {loading ? (
          <div className="empty-state">
            <strong>Carregando itens...</strong>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <strong>Nenhum item salvo</strong>
            <p>Adicione seu primeiro link para montar o dashboard.</p>
            <Link className="button button-secondary" to="/add">
              Adicionar agora
            </Link>
          </div>
        ) : (
          <div className="item-list">
            {items.map((item) => (
              <article key={item.id} className="item-row">
                <div className="item-thumb">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.title || 'Imagem do item'} />
                  ) : (
                    <span>Sem imagem</span>
                  )}
                </div>

                <div className="item-content">
                  <div className="item-title-line">
                    <h3>{item.title || 'Item sem título'}</h3>
                    <span className="group-pill">
                      {item.groupId ? groupNameById[item.groupId] || 'Grupo removido' : 'Sem grupo'}
                    </span>
                  </div>
                  <p>{item.description || 'Descrição indisponível.'}</p>
                  <a href={item.url} target="_blank" rel="noreferrer">Abrir link</a>
                </div>

                <div className="price-block">
                  <span>Preço</span>
                  <strong>{item.price || 'Indisponível'}</strong>
                </div>
              </article>
            ))}

            <div className="list-total">
              <span>Soma de todos os itens</span>
              <strong>{formatCurrency(totalAmount)}</strong>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
