import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';

export async function createGroup(userId, { name, description = '' }) {
  if (!userId) {
    throw new Error('Usuário não autenticado.');
  }

  return addDoc(collection(db, 'groups'), {
    ownerId: userId,
    name,
    description,
    createdAt: serverTimestamp(),
  });
}

export async function listGroups(userId) {
  if (!userId) {
    return [];
  }

  const groupsQuery = query(
    collection(db, 'groups'),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'desc'),
  );

  const snapshot = await getDocs(groupsQuery);
  return snapshot.docs.map((groupDoc) => ({ id: groupDoc.id, ...groupDoc.data() }));
}

export async function deleteGroup(groupId) {
  if (!groupId) {
    throw new Error('Grupo inválido.');
  }

  await deleteDoc(doc(db, 'groups', groupId));
}

export async function addItem(userId, itemData) {
  if (!userId) {
    throw new Error('Usuário não autenticado.');
  }

  return addDoc(collection(db, 'items'), {
    ownerId: userId,
    groupId: itemData.groupId || null,
    url: itemData.url ?? '',
    title: itemData.title ?? '',
    description: itemData.description ?? '',
    imageUrl: itemData.imageUrl ?? '',
    price: itemData.price ?? '',
    createdAt: serverTimestamp(),
  });
}

export async function addItemToGroup(userId, groupId, itemData) {
  return addItem(userId, { ...itemData, groupId });
}

export async function listItems(userId, groupId) {
  if (!userId) {
    return [];
  }

  const filters = [
    where('ownerId', '==', userId),
  ];

  if (groupId !== undefined) {
    filters.push(where('groupId', '==', groupId || null));
  }

  const itemsQuery = query(
    collection(db, 'items'),
    ...filters,
    orderBy('createdAt', 'desc'),
  );

  const snapshot = await getDocs(itemsQuery);
  return snapshot.docs.map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }));
}
