import React, { useEffect, useState } from 'react';
import { FlatList, Text } from 'react-native';
import { listarPedidos } from '../api/pedidos';

export default function HistoricoScreen() {
  const [pedidos, setPedidos] = useState<{ id: string }[]>([]);
  useEffect(() => { listarPedidos().then(setPedidos); }, []);
  return <FlatList data={pedidos} renderItem={({ item }) => <Text>{item.id}</Text>} />;
}
