import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { addItem, createGroup, deleteGroup, listGroups, listItems } from '../services/firestore';
import { extractItemMetadata } from '../services/metadata';

export default function AddItemPage() {
  const { user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [items, setItems] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [manualPrice, setManualPrice] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingLink, setLoadingLink] = useState(false);
  const [message, setMessage] = useState('');

  const groupItemCount = useMemo(() => {
    return items.reduce((acc, item) => {
      const key = item.groupId || 'ungrouped';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }, [items]);

  const loadData = async () => {
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
    loadData();
  }, [user?.uid]);

  const handleCreateGroup = async (event) => {
    event.preventDefault();
    if (!groupName.trim()) {
      setMessage('Informe um nome para o grupo.');
      return;
    }

    try {
      await createGroup(user.uid, {
        name: groupName.trim(),
        description: groupDescription.trim(),
      });
      setGroupName('');
      setGroupDescription('');
      setMessage('Grupo criado com sucesso.');
      await loadData();
    } catch (error) {
      setMessage(error.message || 'Não foi possível criar o grupo.');
    }
  };

  const handleDeleteGroup = async (groupId) => {
    try {
      await deleteGroup(groupId);
      setMessage('Grupo removido.');
      await loadData();
      if (selectedGroupId === groupId) {
        setSelectedGroupId('');
      }
    } catch (error) {
      setMessage(error.message || 'Não foi possível remover o grupo.');
    }
  };

  const handleAddLink = async (event) => {
    event.preventDefault();
    if (!linkUrl.trim()) {
      setMessage('Informe o link do produto.');
      return;
    }

    try {
      setLoadingLink(true);
      setMessage('');
      const metadata = await extractItemMetadata(linkUrl.trim());
      await addItem(user.uid, {
        url: linkUrl.trim(),
        groupId: selectedGroupId || null,
        ...metadata,
        description: manualDescription.trim() || metadata.description,
        price: manualPrice.trim() || metadata.price,
      });
      setLinkUrl('');
      setManualPrice('');
      setManualDescription('');
      setSelectedGroupId('');
      setMessage('Link adicionado com sucesso.');
      await loadData();
    } catch (error) {
      setMessage(error.message || 'Não foi possível salvar o link.');
    } finally {
      setLoadingLink(false);
    }
  };

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Cadastro</p>
          <h1>Adicionar item</h1>
        </div>
        <Link className="button button-secondary" to="/dashboard">
          Ver dashboard
        </Link>
      </div>

      {message ? <p className="notice">{message}</p> : null}

      <div className="form-grid">
        <section className="tool-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Produto</p>
              <h2>Novo link</h2>
            </div>
          </div>

          <form onSubmit={handleAddLink} className="stacked-form">
            <label>
              Link do produto
              <input
                type="url"
                placeholder="https://loja.com/produto"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                required
              />
            </label>

            <label>
              Grupo
              <select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}>
                <option value="">Sem grupo</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
            </label>

            <label>
              Preço manual
              <input
                type="text"
                placeholder="Opcional, ex: R$ 299,90"
                value={manualPrice}
                onChange={(event) => setManualPrice(event.target.value)}
              />
            </label>

            <label>
              Descrição manual
              <input
                type="text"
                placeholder="Opcional, usada se o site bloquear a captura"
                value={manualDescription}
                onChange={(event) => setManualDescription(event.target.value)}
              />
            </label>

            <button className="button button-primary" type="submit" disabled={loadingLink}>
              {loadingLink ? 'Capturando...' : 'Adicionar link'}
            </button>
          </form>
        </section>

        <section className="tool-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Organização</p>
              <h2>Grupos</h2>
            </div>
            <span className="counter">{groups.length}</span>
          </div>

          <form onSubmit={handleCreateGroup} className="stacked-form">
            <label>
              Nome
              <input
                type="text"
                placeholder="Casa, tecnologia, viagem..."
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
              />
            </label>

            <label>
              Descrição
              <input
                type="text"
                placeholder="Opcional"
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
              />
            </label>

            <button className="button button-secondary" type="submit">
              Criar grupo
            </button>
          </form>

          {loading ? (
            <p className="muted">Carregando grupos...</p>
          ) : groups.length === 0 ? (
            <div className="empty-inline">
              <strong>Nenhum grupo criado</strong>
              <p>Os links podem ser salvos sem grupo.</p>
            </div>
          ) : (
            <div className="group-rows">
              {groups.map((group) => (
                <article key={group.id} className="group-row">
                  <div>
                    <strong>{group.name}</strong>
                    {group.description ? <p>{group.description}</p> : null}
                    <span>{groupItemCount[group.id] || 0} itens</span>
                  </div>
                  <button
                    className="button button-danger"
                    type="button"
                    onClick={() => handleDeleteGroup(group.id)}
                  >
                    Excluir
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
