import React from 'react';
import { Pressable, Text } from 'react-native';

export default function Botao({ titulo, onPress }: { titulo: string; onPress?: () => void }) {
  return <Pressable onPress={onPress}><Text>{titulo}</Text></Pressable>;
}
