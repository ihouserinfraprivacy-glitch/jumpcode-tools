import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/entregas_bloc.dart';
import 'detalhe_entrega_screen.dart';

class EntregasScreen extends StatelessWidget {
  const EntregasScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<EntregasBloc, EntregasEstado>(
      builder: (context, estado) => ListView(
        children: [
          for (final entrega in estado.entregas)
            ListTile(
              title: Text(entrega.endereco),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => DetalheEntregaScreen(entrega: entrega))),
            ),
        ],
      ),
    );
  }
}
