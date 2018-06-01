#!/bin/sh
echo "Importing MongoDB seeds ..."
mongoimport  --host mongodb --db borderline --collection borderline_server_users --drop --file /mongo_data/users.json
mongoimport  --host mongodb --db borderline --collection borderline_server_extensions --drop --file /mongo_data/extensions.json
mongoimport  --host mongodb --db borderline --collection borderline_server_steps --drop --file /mongo_data/steps.json
mongoimport  --host mongodb --db borderline --collection borderline_server_workflows --drop --file /mongo_data/workflows.json
mongoimport  --host mongodb --db borderline --collection borderline_server_data_sources --drop --file /mongo_data/data_sources.json
