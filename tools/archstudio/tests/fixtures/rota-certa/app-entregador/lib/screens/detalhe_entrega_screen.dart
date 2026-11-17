import 'package:flutter/material.dart';

import '../models/entrega.dart';
import 'comprovante_screen.dart';
import 'mapa_screen.dart';

class DetalheEntregaScreen extends StatelessWidget {
  const DetalheEntregaScreen({super.key, required this.entrega});
  final Entrega entrega;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(entrega.endereco)),
      body: Column(children: [
        Expanded(child: MapaScreen(destino: entrega)),
        ElevatedButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ComprovanteScreen(entrega: entrega))),
          child: const Text('Entregar'),
        ),
      ]),
    );
  }
}
