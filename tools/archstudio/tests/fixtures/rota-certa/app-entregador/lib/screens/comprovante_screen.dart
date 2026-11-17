import 'package:flutter/material.dart';

import '../data/camera/fotos.dart';
import '../models/entrega.dart';
import '../repositories/entregas_repository.dart';

class ComprovanteScreen extends StatelessWidget {
  const ComprovanteScreen({super.key, required this.entrega});
  final Entrega entrega;

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: () async {
        final foto = await Fotos.tirar();
        await EntregasRepository().concluir(entrega, foto);
      },
      child: const Text('Tirar foto do comprovante'),
    );
  }
}
