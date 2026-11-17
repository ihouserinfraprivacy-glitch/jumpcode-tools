import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../blocs/auth_bloc.dart';
import 'entregas_screen.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocListener<AuthBloc, AuthEstado>(
      listener: (context, estado) {
        if (estado.logado) {
          Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const EntregasScreen()));
        }
      },
      child: const Scaffold(body: Center(child: Text('Entrar'))),
    );
  }
}
