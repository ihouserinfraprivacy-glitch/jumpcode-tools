import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import 'package:app_entregador/blocs/auth_bloc.dart';
import 'package:app_entregador/blocs/entregas_bloc.dart';
import 'package:app_entregador/screens/login_screen.dart';
import 'push/notificacoes_push.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await NotificacoesPush.iniciar();
  runApp(MultiBlocProvider(
    providers: [
      BlocProvider(create: (_) => AuthBloc()),
      BlocProvider(create: (_) => EntregasBloc()),
    ],
    child: const MaterialApp(home: LoginScreen()),
  ));
}
